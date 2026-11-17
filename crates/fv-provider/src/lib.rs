use anyhow::{Context, Result, ensure};
use fv_config::Config;
use reqwest::blocking::Client;
use serde_json::{Value, json};
use std::time::Duration;

pub struct Hetzner {
    client: Client,
    token: String,
}
impl Hetzner {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: Client::builder().timeout(Duration::from_secs(60)).build()?,
            token: std::env::var("HCLOUD_TOKEN").context("HCLOUD_TOKEN required")?,
        })
    }
    fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut r = self
            .client
            .request(method, format!("https://api.hetzner.cloud/v1/{path}"))
            .bearer_auth(&self.token);
        if let Some(b) = body {
            r = r.json(&b)
        }
        let response = r.send()?;
        ensure!(
            response.status().is_success(),
            "provider operation failed: HTTP {}",
            response.status()
        );
        Ok(response.json()?)
    }
    pub fn plan(c: &Config) -> Value {
        json!({"environment":c.environment,"owner":c.project,"resources":["private-network","firewall","server"],"destructive":false,"ssh_cidrs":c.ssh_cidrs,"wireguard_udp":c.wireguard_port,"public_http":false,"location":c.provider.location,"type":c.provider.server_type,"image":c.provider.image})
    }
    pub fn status(&self, c: &Config) -> Result<Value> {
        self.call(
            reqwest::Method::GET,
            &format!("servers?label_selector=fv-owner%3D{}", c.project),
            None,
        )
    }
    pub fn apply(&self, c: &Config, cloud_init: &str) -> Result<Value> {
        ensure!(
            c.environment != "local",
            "local manifest cannot create cloud resources"
        );
        let existing = self.status(c)?;
        let servers = existing["servers"]
            .as_array()
            .context("invalid server listing")?;
        ensure!(servers.len() <= 1, "ambiguous managed servers");
        let mut rules = vec![
            json!({"direction":"in","protocol":"udp","port":c.wireguard_port.to_string(),"source_ips":["0.0.0.0/0","::/0"]}),
            json!({"direction":"in","protocol":"icmp","source_ips":["0.0.0.0/0","::/0"]}),
        ];
        rules.push(json!({"direction":"in","protocol":"tcp","port":"22","source_ips":c.ssh_cidrs}));
        let fws = self.call(
            reqwest::Method::GET,
            &format!("firewalls?label_selector=fv-owner%3D{}", c.project),
            None,
        )?;
        let list = fws["firewalls"]
            .as_array()
            .context("invalid firewall listing")?;
        ensure!(list.len() <= 1, "ambiguous firewalls");
        let fw = if let Some(fw) = list.first() {
            self.call(
                reqwest::Method::POST,
                &format!("firewalls/{}/actions/set_rules", fw["id"]),
                Some(json!({"rules":rules})),
            )?;
            fw.clone()
        } else {
            self.call(reqwest::Method::POST,"firewalls",Some(json!({"name":format!("{}-firewall",c.project),"labels":{"fv-owner":c.project},"rules":rules})))?["firewall"].clone()
        };
        let networks = self.call(
            reqwest::Method::GET,
            &format!("networks?label_selector=fv-owner%3D{}", c.project),
            None,
        )?;
        let ns = networks["networks"]
            .as_array()
            .context("invalid network listing")?;
        ensure!(ns.len() <= 1, "ambiguous networks");
        let net = if let Some(n) = ns.first() {
            n.clone()
        } else {
            self.call(reqwest::Method::POST,"networks",Some(json!({"name":format!("{}-network",c.project),"ip_range":"10.91.0.0/16","labels":{"fv-owner":c.project}})))?["network"].clone()
        };
        if net["subnets"].as_array().is_none_or(|s| s.is_empty()) {
            self.call(reqwest::Method::POST,&format!("networks/{}/actions/add_subnet",net["id"]),Some(json!({"type":"cloud","network_zone":if c.provider.location=="ash" || c.provider.location=="hil" {"us-east"}else{"eu-central"},"ip_range":"10.91.1.0/24"})))?;
        }
        if let Some(server) = servers.first() {
            ensure!(
                server["server_type"]["name"] == c.provider.server_type
                    && server["datacenter"]["location"]["name"] == c.provider.location,
                "server drift requires explicit migration"
            );
            self.call(
                reqwest::Method::POST,
                &format!("firewalls/{}/actions/apply_to_resources", fw["id"]),
                Some(json!({"apply_to":[{"type":"server","server":{"id":server["id"]}}]})),
            )?;
            return Ok(
                json!({"server_id":server["id"],"status":"converged","public_ip":server["public_net"]["ipv4"]["ip"]}),
            );
        }
        let created=self.call(reqwest::Method::POST,"servers",Some(json!({"name":c.project,"server_type":c.provider.server_type,"image":c.provider.image,"location":c.provider.location,"ssh_keys":c.provider.ssh_key_ids,"networks":[net["id"]],"firewalls":[{"firewall":fw["id"]}],"labels":{"fv-owner":c.project},"user_data":cloud_init,"start_after_create":true})))?;
        Ok(
            json!({"server_id":created["server"]["id"],"status":"provisioning","public_ip":created["server"]["public_net"]["ipv4"]["ip"]}),
        )
    }
}
