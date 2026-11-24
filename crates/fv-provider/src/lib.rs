use anyhow::{Context, Result, ensure};
use fv_config::{Architecture, Config};
use reqwest::{Method, blocking::Client};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

mod project;

const NETWORK_RANGE: &str = "10.91.0.0/16";
const SUBNET_RANGE: &str = "10.91.1.0/24";

pub struct Hetzner {
    client: Client,
    token: String,
    endpoint: String,
}

impl Hetzner {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            token: std::env::var("FV_HCLOUD_TOKEN")
                .or_else(|_| std::env::var("HCLOUD_TOKEN"))
                .context("Founder Village Hetzner project token required")?,
            endpoint: "https://api.hetzner.cloud/v1".into(),
        })
    }

    fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut request = self
            .client
            .request(method, format!("{}/{path}", self.endpoint))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().map_err(|error| error.without_url())?;
        ensure!(
            response.status().is_success(),
            "Hetzner operation failed: HTTP {}",
            response.status()
        );
        Ok(response.json()?)
    }

    fn find(&self, kind: &str, query: &str) -> Result<Option<Value>> {
        let result = self.call(Method::GET, &format!("{kind}?{query}"), None)?;
        let items = result[kind]
            .as_array()
            .context("invalid Hetzner inventory")?;
        ensure!(
            items.len() <= 1 && result["meta"]["pagination"]["next_page"].is_null(),
            "ambiguous Hetzner resources: {kind}"
        );
        Ok(items.first().cloned())
    }

    fn server(&self, id: u64) -> Result<Value> {
        Ok(self.call(Method::GET, &format!("servers/{id}"), None)?["server"].clone())
    }

    pub fn plan(c: &Config) -> Value {
        json!({
            "environment": c.environment,
            "owner": c.project,
            "selection": if c.provider.existing_server.is_some() {"existing-server-only"} else {"owned-or-create"},
            "resources": ["private-network", "firewall", "server"],
            "destructive": false,
            "ssh_cidrs": c.ssh_cidrs,
            "wireguard_udp": c.cloudflare.ssh_domain.is_none().then_some(c.wireguard_port),
            "tunnel_ssh": c.cloudflare.ssh_domain.is_some(),
            "public_inbound_rules": firewall_rules(c).len(),
            "public_http": false,
            "location": c.provider.location,
            "type": c.provider.server_type,
            "image": c.provider.image,
            "platform": format!("linux/{}", c.provider.architecture.oci())
        })
    }

    pub fn status(&self, c: &Config) -> Result<Value> {
        let project = self.project_inventory(c)?;
        let Some(server) = project.server else {
            return Ok(json!({"status":"absent","project_isolated":true}));
        };
        let firewall = project.firewall.unwrap_or(Value::Null);
        let network = project.network.unwrap_or(Value::Null);
        Ok(json!({
            "project_isolated": true,
            "status": server["status"],
            "platform": format!("linux/{}", c.provider.architecture.oci()),
            "owned": server["labels"]["fv-owner"] == c.project,
            "firewall_applied": firewall_applied(&server, &firewall["id"]),
            "firewall_rules_match": firewall_rules_match(c, &firewall),
            "public_inbound_closed": firewall_applied(&server, &firewall["id"])
                && server["public_net"]["firewalls"].as_array().is_some_and(|rules| rules.len() == 1)
                && firewall["rules"].as_array().is_some_and(Vec::is_empty),
            "network_attached": network_attached(&server, &network["id"]),
            "delete_protected": server["protection"]["delete"] == true,
            "rebuild_protected": server["protection"]["rebuild"] == true
        }))
    }

    pub fn apply(&self, c: &Config, cloud_init: Option<&str>) -> Result<Value> {
        ensure!(
            c.environment != "local",
            "local manifest cannot provision cloud resources"
        );
        let project = self.project_inventory(c)?;
        let existing = project.server;
        ensure!(
            existing
                .as_ref()
                .is_some_and(|server| server["labels"]["fv-owner"] == c.project)
                || !c.ssh_cidrs.is_empty(),
            "initial server provisioning requires a bootstrap SSH CIDR"
        );
        let image = if existing.is_none() {
            ensure!(
                cloud_init.is_some()
                    && !c.provider.ssh_key_ids.is_empty()
                    && !c.ssh_cidrs.is_empty(),
                "new server requires --public-key, provider SSH key IDs and bootstrap CIDRs"
            );
            let arch = hetzner_arch(c.provider.architecture);
            let model = self
                .find("server_types", &format!("name={}", c.provider.server_type))?
                .context("Hetzner server type not found")?;
            ensure!(
                model["architecture"] == arch,
                "Hetzner server type architecture mismatch"
            );
            let image = self
                .find(
                    "images",
                    &format!("name={}&architecture={arch}&type=system", c.provider.image),
                )?
                .context("matching Hetzner system image not found")?;
            ensure!(
                image["architecture"] == arch,
                "Hetzner OS image architecture mismatch"
            );
            Some(resource_id(&image)?)
        } else {
            None
        };

        let firewall = project.firewall;
        let network = project.network;
        let labels = json!({"fv-owner": c.project});
        let rules = firewall_rules(c);
        let firewall_id = if let Some(firewall) = firewall {
            let id = resource_id(&firewall)?;
            if !firewall_rules_match(c, &firewall) {
                let fresh = self.call(Method::GET, &format!("firewalls/{id}"), None)?;
                let fresh = &fresh["firewall"];
                ensure!(
                    fresh["id"] == id
                        && fresh["name"] == firewall["name"]
                        && fresh["labels"]["fv-owner"] == c.project,
                    "firewall ownership changed before rule update"
                );
                check_attachments(
                    existing.as_ref(),
                    Some(fresh),
                    network.as_ref(),
                    &project.zone,
                )?;
                let result = self.call(
                    Method::POST,
                    &format!("firewalls/{id}/actions/set_rules"),
                    Some(json!({"rules":rules})),
                )?;
                self.wait_many("firewalls", &result["actions"])?;
            }
            id
        } else {
            let result = self.call(
                Method::POST,
                "firewalls",
                Some(json!({
                    "name":format!("{}-firewall", c.project), "labels":labels, "rules":rules
                })),
            )?;
            self.wait_many("firewalls", &result["actions"])?;
            resource_id(&result["firewall"])?
        };
        let subnet = json!({"type":"cloud", "network_zone":project.zone, "ip_range":SUBNET_RANGE});
        let network_id = if let Some(network) = network {
            let id = resource_id(&network)?;
            if list(&network, "subnets")?.is_empty() {
                let result = self.call(
                    Method::POST,
                    &format!("networks/{id}/actions/add_subnet"),
                    Some(subnet),
                )?;
                self.wait("networks", &result["action"])?;
            }
            id
        } else {
            let result = self.call(
                Method::POST,
                "networks",
                Some(json!({
                    "name":format!("{}-network", c.project), "labels":labels,
                    "ip_range":NETWORK_RANGE, "subnets":[subnet]
                })),
            )?;
            resource_id(&result["network"])?
        };

        let id = if let Some(server) = &existing {
            let id = resource_id(server)?;
            if !firewall_applied(server, &json!(firewall_id)) {
                let result = self.call(
                    Method::POST,
                    &format!("firewalls/{firewall_id}/actions/apply_to_resources"),
                    Some(json!({
                        "apply_to":[{"type":"server","server":{"id":id}}]
                    })),
                )?;
                self.wait_many("firewalls", &result["actions"])?;
            }
            if !network_attached(server, &json!(network_id)) {
                let result = self.call(
                    Method::POST,
                    &format!("servers/{id}/actions/attach_to_network"),
                    Some(json!({"network":network_id})),
                )?;
                self.wait("servers", &result["action"])?;
            }
            id
        } else {
            let result = self.call(
                Method::POST,
                "servers",
                Some(json!({
                    "name":c.project, "server_type":c.provider.server_type, "image":image,
                    "location":c.provider.location, "ssh_keys":c.provider.ssh_key_ids,
                    "networks":[network_id], "firewalls":[{"firewall":firewall_id}],
                    "labels":labels, "user_data":cloud_init, "start_after_create":true
                })),
            )?;
            self.wait("servers", &result["action"])?;
            self.wait_many("servers", &result["next_actions"])?;
            resource_id(&result["server"])?
        };

        let mut server = self.server(id)?;
        check_server(c, &server)?;
        let firewall = self.call(Method::GET, &format!("firewalls/{firewall_id}"), None)?;
        ensure!(
            firewall_applied(&server, &json!(firewall_id))
                && network_attached(&server, &json!(network_id))
                && firewall_rules_match(c, &firewall["firewall"]),
            "Hetzner firewall and network attachment verification failed"
        );
        if server["protection"]["delete"] != true || server["protection"]["rebuild"] != true {
            let result = self.call(
                Method::POST,
                &format!("servers/{id}/actions/change_protection"),
                Some(json!({"delete":true,"rebuild":true})),
            )?;
            self.wait("servers", &result["action"])?;
        }
        if server["labels"]["fv-owner"].is_null() {
            let mut updated = server["labels"]
                .as_object()
                .context("server labels missing")?
                .clone();
            updated.insert("fv-owner".into(), json!(c.project));
            self.call(
                Method::PUT,
                &format!("servers/{id}"),
                Some(json!({"labels":updated})),
            )?;
        }
        server = self.server(id)?;
        check_server(c, &server)?;
        ensure!(
            server["labels"]["fv-owner"] == c.project
                && server["protection"]["delete"] == true
                && server["protection"]["rebuild"] == true,
            "Hetzner ownership or protection verification failed"
        );
        // Fail the provider receipt if another controller changed project scope during application.
        self.project_inventory(c)?;
        Ok(json!({
            "server_id":id, "status":"converged",
            "public_ip":server["public_net"]["ipv4"]["ip"],
            "platform":format!("linux/{}", c.provider.architecture.oci())
        }))
    }

    fn wait_many(&self, kind: &str, actions: &Value) -> Result<()> {
        for action in actions.as_array().context("missing Hetzner action list")? {
            self.wait(kind, action)?;
        }
        Ok(())
    }

    fn wait(&self, kind: &str, action: &Value) -> Result<()> {
        let id = resource_id(action)?;
        let started = Instant::now();
        let mut status = action["status"].clone();
        loop {
            if status == "success" {
                return Ok(());
            }
            ensure!(status == "running", "Hetzner action failed");
            ensure!(
                started.elapsed() < Duration::from_secs(180),
                "Hetzner action timed out"
            );
            std::thread::sleep(Duration::from_secs(1));
            status =
                self.call(Method::GET, &format!("{kind}/actions/{id}"), None)?["action"]["status"]
                    .clone();
        }
    }
}

fn hetzner_arch(arch: Architecture) -> &'static str {
    match arch {
        Architecture::Amd64 => "x86",
        Architecture::Arm64 => "arm",
    }
}

fn resource_id(resource: &Value) -> Result<u64> {
    resource["id"]
        .as_u64()
        .filter(|id| *id > 0)
        .context("missing Hetzner resource ID")
}

fn list<'a>(resource: &'a Value, key: &str) -> Result<&'a [Value]> {
    Ok(resource[key]
        .as_array()
        .context("incomplete Hetzner inventory")?)
}

fn check_server(c: &Config, server: &Value) -> Result<()> {
    let location = server["location"]["name"]
        .as_str()
        .or_else(|| server["datacenter"]["location"]["name"].as_str());
    ensure!(
        server["name"] == c.project
            && location == Some(c.provider.location.as_str())
            && server["server_type"]["name"] == c.provider.server_type
            && server["server_type"]["architecture"] == hetzner_arch(c.provider.architecture)
            && server["image"]["name"] == c.provider.image
            && server["image"]["architecture"] == hetzner_arch(c.provider.architecture),
        "server name, location, type, or OS image drift; explicit migration required"
    );
    let owner = &server["labels"]["fv-owner"];
    ensure!(
        owner.is_null() || owner == &c.project,
        "server belongs to another runtime"
    );
    if let Some(binding) = &c.provider.existing_server {
        ensure!(
            server["id"] == binding.id
                && server["public_net"]["ipv4"]["ip"] == binding.ipv4.to_string(),
            "existing server ID or IPv4 mismatch"
        );
    }
    Ok(())
}

fn firewall_rules(c: &Config) -> Vec<Value> {
    let mut rules = Vec::new();
    if c.cloudflare.ssh_domain.is_none() {
        rules.push(json!({"direction":"in","protocol":"udp","port":c.wireguard_port.to_string(),"source_ips":["0.0.0.0/0","::/0"]}));
        rules.push(json!({"direction":"in","protocol":"icmp","source_ips":["0.0.0.0/0","::/0"]}));
    }
    if !c.ssh_cidrs.is_empty() {
        rules.push(json!({"direction":"in","protocol":"tcp","port":"22","source_ips":c.ssh_cidrs}));
    }
    rules
}

fn firewall_rules_match(c: &Config, firewall: &Value) -> bool {
    let desired = firewall_rules(c);
    let Some(actual) = firewall["rules"].as_array() else {
        return false;
    };
    actual.len() == desired.len()
        && desired.iter().all(|expected| {
            actual.iter().any(|rule| {
                rule["direction"] == expected["direction"]
                    && rule["protocol"] == expected["protocol"]
                    && rule["port"].as_str().unwrap_or_default()
                        == expected["port"].as_str().unwrap_or_default()
                    && rule["source_ips"]
                        .as_array()
                        .zip(expected["source_ips"].as_array())
                        .is_some_and(|(actual, expected)| {
                            actual.len() == expected.len()
                                && expected.iter().all(|ip| actual.contains(ip))
                        })
            })
        })
}

fn check_attachments(
    server: Option<&Value>,
    firewall: Option<&Value>,
    network: Option<&Value>,
    zone: &str,
) -> Result<()> {
    let id = server.map(resource_id).transpose()?;
    let firewall_id = firewall.map(resource_id).transpose()?;
    let network_id = network.map(resource_id).transpose()?;
    if let Some(server) = server {
        ensure!(
            list(&server["public_net"], "firewalls")?
                .iter()
                .all(|entry| firewall_id.is_some_and(|owned| entry["id"] == owned))
                && list(server, "private_net")?
                    .iter()
                    .all(|entry| network_id.is_some_and(|owned| entry["network"] == owned))
                && list(server, "load_balancers")?.is_empty(),
            "existing server has unmanaged network, firewall or load balancer attachments"
        );
    }
    if let Some(firewall) = firewall {
        ensure!(
            list(firewall, "applied_to")?
                .iter()
                .all(|entry| entry["type"] == "server"
                    && id.is_some_and(|id| entry["server"]["id"] == id)),
            "owned firewall applies to unexpected resources"
        );
    }
    if let Some(network) = network {
        let subnets = list(network, "subnets")?;
        ensure!(
            network["ip_range"] == NETWORK_RANGE
                && (subnets.is_empty()
                    || (subnets.len() == 1
                        && subnets[0]["type"] == "cloud"
                        && subnets[0]["ip_range"] == SUBNET_RANGE
                        && subnets[0]["network_zone"] == zone))
                && list(network, "routes")?.is_empty()
                && list(network, "load_balancers")?.is_empty()
                && list(network, "servers")?
                    .iter()
                    .all(|entry| entry.as_u64() == id),
            "owned private network drift requires review"
        );
    }
    Ok(())
}

fn firewall_applied(server: &Value, firewall: &Value) -> bool {
    !firewall.is_null()
        && server["public_net"]["firewalls"]
            .as_array()
            .is_some_and(|entries| {
                entries
                    .iter()
                    .any(|entry| entry["id"] == *firewall && entry["status"] == "applied")
            })
}

fn network_attached(server: &Value, network: &Value) -> bool {
    !network.is_null()
        && server["private_net"]
            .as_array()
            .is_some_and(|entries| entries.iter().any(|entry| entry["network"] == *network))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adoption_rejects_target_drift_and_unmanaged_ingress() {
        let mut config: Config =
            serde_json::from_str(include_str!("../../../config/remote.example.json")).unwrap();
        config.provider.existing_server = Some(fv_config::ExistingServer {
            id: 42,
            ipv4: "203.0.113.10".parse().unwrap(),
        });
        let server = json!({
            "id":42, "name":config.project, "location":{"name":"hel1"},
            "server_type":{"name":"cax11","architecture":"arm"},
            "image":{"name":"ubuntu-24.04","architecture":"arm"},
            "public_net":{"ipv4":{"ip":"203.0.113.10"},"firewalls":[]},
            "private_net":[], "load_balancers":[], "labels":{}
        });
        assert!(check_server(&config, &server).is_ok());
        assert!(check_attachments(Some(&server), None, None, "eu-central").is_ok());
        for (key, value) in [
            ("/public_net/ipv4/ip", json!("203.0.113.11")),
            ("/server_type/architecture", json!("x86")),
            ("/location/name", json!("fsn1")),
            ("/labels", json!({"fv-owner":"another-runtime"})),
        ] {
            let mut wrong = server.clone();
            *wrong.pointer_mut(key).unwrap() = value;
            assert!(check_server(&config, &wrong).is_err());
        }
        let mut exposed = server;
        exposed["public_net"]["firewalls"] = json!([{"id":77,"status":"applied"}]);
        assert!(check_attachments(Some(&exposed), None, None, "eu-central").is_err());
        assert_eq!(firewall_rules(&config).len(), 1);
        assert!(
            firewall_rules(&config)
                .iter()
                .any(|rule| rule["port"] == "22")
        );
        config.ssh_cidrs.clear();
        assert!(firewall_rules(&config).is_empty());
        config.cloudflare.ssh_domain = None;
        assert!(
            firewall_rules(&config)
                .iter()
                .any(|rule| rule["protocol"] == "udp")
        );
    }
}
