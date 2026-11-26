use super::{Hetzner, Target, check_attachments, check_server, list, resource_id};
use anyhow::{Context, Result, bail, ensure};
use fv_config::{Config, ProviderCandidate};
use reqwest::Method;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

// The Cloud API token is scoped to one Hetzner project. Ownership checks must
// see the entire project, including unlabelled instances and unused resources.
const COLLECTIONS: &[&str] = &[
    "servers",
    "ssh_keys",
    "firewalls",
    "networks",
    "primary_ips",
    "floating_ips",
    "volumes",
    "load_balancers",
    "placement_groups",
    "certificates",
    "zones",
    "snapshots",
    "backups",
    "storage_boxes",
];
type Resources = BTreeMap<u64, Value>;
type Inventory = BTreeMap<&'static str, Resources>;

pub(super) struct Project {
    pub(super) server: Option<Value>,
    pub(super) firewall: Option<Value>,
    pub(super) network: Option<Value>,
    pub(super) zone: String,
    counts: BTreeMap<&'static str, usize>,
}

impl Hetzner {
    fn all_project_resources(&self, kind: &str) -> Result<Resources> {
        let (collection, filter) = match kind {
            "snapshots" => ("images", "&type=snapshot"),
            "backups" => ("images", "&type=backup"),
            other => (other, ""),
        };
        let mut rows = Resources::new();
        for page in 1..=100 {
            let path = format!("{collection}?page={page}&per_page=50{filter}");
            let endpoint = if kind == "storage_boxes" {
                &self.storage_endpoint
            } else {
                &self.endpoint
            };
            let body = self.request(endpoint, Method::GET, &path, None)?;
            let batch = list(&body, collection)?;
            let pagination = &body["meta"]["pagination"];
            ensure!(
                pagination["page"].as_u64() == Some(page)
                    && pagination["per_page"] == 50
                    && batch.len() <= 50,
                "incomplete project inventory for {kind}"
            );
            for row in batch {
                let id = resource_id(row)?;
                ensure!(
                    rows.insert(id, row.clone()).is_none(),
                    "duplicate project resource in {kind}"
                );
            }
            match pagination.get("next_page") {
                Some(Value::Null) => {
                    if let Some(count) = pagination["total_entries"].as_u64() {
                        ensure!(
                            rows.len() as u64 == count,
                            "project inventory changed for {kind}"
                        );
                    }
                    return Ok(rows);
                }
                Some(next) if next.as_u64() == Some(page + 1) && !batch.is_empty() => {}
                _ => bail!("incomplete project pagination for {kind}"),
            }
        }
        bail!("project inventory exceeded page limit for {kind}")
    }

    pub(super) fn project_inventory<'a>(&self, target: impl Into<Target<'a>>) -> Result<Project> {
        let config = target.into();
        ensure!(
            config.environment != "local",
            "local manifest cannot select a provider project"
        );
        let mut inventory = Inventory::new();
        for &kind in COLLECTIONS {
            inventory.insert(kind, self.all_project_resources(kind)?);
        }
        let location = self
            .find("locations", &format!("name={}", config.location))?
            .context("Hetzner location not found")?;
        let zone = location["network_zone"]
            .as_str()
            .context("location has no network zone")?;
        assess(config, &inventory, zone)
    }

    /// Counts only. Resource contents and credentials stay on the workstation.
    pub fn audit(&self, config: &Config) -> Result<Value> {
        let project = self.project_inventory(config)?;
        Ok(
            json!({"project_isolated": true, "resources": project.counts,
            "binding": if config.provider.existing_server.is_some() {"server-id-and-address"} else {"registered-ssh-key-ids"}}),
        )
    }

    /// Report only the verified shape and aggregate ownership evidence.
    pub(super) fn existing_candidate(&self, candidate: &ProviderCandidate) -> Result<Value> {
        let project = self.project_inventory(candidate)?;
        let server = project
            .server
            .context("existing candidate missing from inventory")?;
        Ok(json!({
            "project_isolated": true,
            "binding": "server-id-and-address",
            "location": candidate.provider.location,
            "server_type": candidate.provider.server_type,
            "image": server["image"]["name"],
            "root_disk_gb": server["primary_disk_size"].as_u64(),
            "platform": format!("linux/{}", candidate.provider.architecture.oci()),
            "running": server["status"] == "running",
            "resources": project.counts
        }))
    }
}

fn owned<'a>(resources: &'a Resources, project: &str, suffix: &str) -> Result<Option<&'a Value>> {
    let mut owned = resources
        .values()
        .filter(|row| row["labels"]["fv-owner"] == project);
    let first = owned.next();
    ensure!(
        owned.next().is_none(),
        "ambiguous ownership in project inventory"
    );
    if let Some(row) = first {
        ensure!(
            row["name"] == format!("{project}{suffix}"),
            "unexpected owned resource name"
        );
    }
    Ok(first)
}

fn assess<'a>(target: impl Into<Target<'a>>, all: &Inventory, zone: &str) -> Result<Project> {
    let c = target.into();
    let mut allowed: BTreeMap<&str, BTreeSet<u64>> = COLLECTIONS
        .iter()
        .map(|&kind| (kind, BTreeSet::new()))
        .collect();
    for (kind, ids) in c.project_resource_ids {
        let expected = allowed
            .get_mut(kind.as_str())
            .context("unknown provider resource kind")?;
        for &id in ids {
            ensure!(
                id != 0 && expected.insert(id),
                "invalid private project resource binding"
            );
        }
    }
    let keys = allowed.get_mut("ssh_keys").unwrap();
    for &id in c.ssh_key_ids {
        ensure!(
            id != 0 && all["ssh_keys"].contains_key(&id),
            "registered project SSH key missing from token scope"
        );
        keys.insert(id);
    }
    let labelled = owned(&all["servers"], c.project, "")?;
    let server = if let Some(binding) = c.existing_server {
        ensure!(
            labelled.is_none_or(|row| row["id"] == binding.id),
            "another server claims this runtime's ownership"
        );
        Some(
            all["servers"]
                .get(&binding.id)
                .context("bound server missing from token scope")?,
        )
    } else {
        ensure!(
            !c.ssh_key_ids.is_empty(),
            "new allocation requires private registered project SSH key IDs"
        );
        labelled
    };
    if let Some(server) = server {
        check_server(c, server)?;
        allowed
            .get_mut("servers")
            .unwrap()
            .insert(resource_id(server)?);
    }
    ensure!(
        all["servers"]
            .values()
            .all(|row| row["name"] != c.project || Some(row) == server),
        "existing server name requires an explicit private binding"
    );
    let members = allowed["servers"].clone();
    for (&id, sibling) in &all["servers"] {
        if Some(sibling) != server {
            let owner = sibling["labels"]["fv-owner"].as_str();
            ensure!(
                members.contains(&id) && owner.is_some() && owner == sibling["name"].as_str(),
                "unexpected server in the provider project's unfiltered inventory"
            );
        }
    }
    let firewall = owned(&all["firewalls"], c.project, "-firewall")?;
    let network = owned(&all["networks"], c.project, "-network")?;
    check_attachments(server, firewall, network, zone)?;
    for (kind, row) in [("firewalls", firewall), ("networks", network)] {
        if let Some(row) = row {
            allowed.get_mut(kind).unwrap().insert(resource_id(row)?);
        }
    }

    for firewall in all["firewalls"].values() {
        ensure!(
            list(firewall, "applied_to")?
                .iter()
                .all(|entry| entry["type"] == "server"
                    && entry["server"]["id"]
                        .as_u64()
                        .is_some_and(|id| members.contains(&id))),
            "foreign or selector-based project firewall attachment"
        );
    }
    for network in all["networks"].values() {
        ensure!(
            list(network, "servers")?
                .iter()
                .all(|entry| entry.as_u64().is_some_and(|id| members.contains(&id))),
            "foreign project network attachment"
        );
    }
    for balancer in all["load_balancers"].values() {
        ensure!(
            list(balancer, "targets")?
                .iter()
                .all(|target| target["type"] == "server"
                    && target["server"]["id"]
                        .as_u64()
                        .is_some_and(|id| members.contains(&id))),
            "unverified load balancer target in project"
        );
    }
    for group in all["placement_groups"].values() {
        ensure!(
            list(group, "servers")?
                .iter()
                .all(|entry| entry.as_u64().is_some_and(|id| members.contains(&id))),
            "foreign placement group member in project"
        );
    }
    for (kind, field) in [
        ("primary_ips", "/assignee_id"),
        ("floating_ips", "/server"),
        ("volumes", "/server"),
    ] {
        for (&id, row) in &all[kind] {
            let association = row
                .pointer(field)
                .context("provider resource association missing")?;
            if !association.is_null() {
                let owner = association
                    .as_u64()
                    .filter(|value| *value > 0)
                    .context("invalid provider resource association")?;
                ensure!(
                    members.contains(&owner),
                    "foreign server association in {kind}"
                );
                if kind == "primary_ips" {
                    ensure!(
                        row["assignee_type"] == "server",
                        "unexpected primary IP association"
                    );
                }
                allowed.get_mut(kind).unwrap().insert(id);
            }
        }
    }
    for kind in ["backups", "snapshots"] {
        for (&id, row) in &all[kind] {
            let bound = row["bound_to"].as_u64();
            ensure!(
                bound.is_none_or(|server| members.contains(&server)),
                "foreign bound image in {kind}"
            );
            let source = row.pointer("/created_from/id").and_then(Value::as_u64);
            if bound.is_some() || source.is_some_and(|server| members.contains(&server)) {
                allowed.get_mut(kind).unwrap().insert(id);
            }
        }
    }
    for &kind in COLLECTIONS {
        ensure!(
            all[kind].keys().copied().eq(allowed[kind].iter().copied()),
            "provider project inventory differs from the private bindings for {kind}"
        );
    }
    Ok(Project {
        server: server.cloned(),
        firewall: firewall.cloned(),
        network: network.cloned(),
        counts: all.iter().map(|(&kind, list)| (kind, list.len())).collect(),
        zone: zone.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fv_config::ExistingServer;
    use reqwest::blocking::Client;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        thread,
        time::Duration,
    };

    fn config() -> Config {
        let mut c: Config =
            serde_json::from_str(include_str!("../../../config/remote.example.json")).unwrap();
        c.provider.existing_server = Some(ExistingServer {
            id: 42,
            ipv4: "203.0.113.10".parse().unwrap(),
        });
        c
    }

    fn fixture(c: &Config) -> Inventory {
        let mut inv: Inventory = COLLECTIONS
            .iter()
            .map(|&key| (key, Resources::new()))
            .collect();
        inv.get_mut("servers").unwrap().insert(
            42,
            json!({
                "id":42, "name":c.project, "location":{"name":"hel1"},
                "server_type":{"name":"cax11","architecture":"arm"},
                "image":{"name":"ubuntu-24.04","architecture":"arm"},
                "public_net":{"ipv4":{"ip":"203.0.113.10"},"firewalls":[]},
                "private_net":[], "load_balancers":[], "labels":{}
            }),
        );
        inv.get_mut("primary_ips").unwrap().insert(
            100,
            json!({"id":100,"assignee_type":"server","assignee_id":42}),
        );
        inv
    }

    #[test]
    fn pins_adoption_and_admits_clean_project_bootstrap_and_retries() {
        let mut c = config();
        let mut rows = fixture(&c);
        assert!(assess(&c, &rows, "eu-central").is_ok());
        rows.get_mut("ssh_keys")
            .unwrap()
            .insert(50, json!({"id":50}));
        assert!(assess(&c, &rows, "eu-central").is_err());
        c.provider.ssh_key_ids = vec![50];
        assert!(assess(&c, &rows, "eu-central").is_ok());
        c.provider.existing_server = None;
        assert!(assess(&c, &rows, "eu-central").is_err());
        rows.get_mut("servers").unwrap().clear();
        rows.get_mut("primary_ips").unwrap().clear();
        assert!(assess(&c, &rows, "eu-central").is_ok());
        rows.get_mut("firewalls").unwrap().insert(9,
            json!({"id":9,"name":format!("{}-firewall",c.project),"labels":{"fv-owner":c.project},"applied_to":[]}));
        assert!(assess(&c, &rows, "eu-central").is_ok());
        c.provider.ssh_key_ids = vec![51];
        assert!(assess(&c, &rows, "eu-central").is_err());
        c.provider.ssh_key_ids.clear();
        assert!(assess(&c, &rows, "eu-central").is_err());
    }

    #[test]
    fn explicit_inventory_cannot_adopt_foreign_attachments_or_selectors() {
        let mut c = config();
        let mut rows = fixture(&c);
        let mut other = rows["servers"][&42].clone();
        other["id"] = json!(43);
        other["name"] = json!("separate-runtime");
        rows.get_mut("servers").unwrap().insert(43, other);
        assert!(assess(&c, &rows, "eu-central").is_err());
        c.provider
            .project_resource_ids
            .insert("servers".into(), vec![43]);
        assert!(assess(&c, &rows, "eu-central").is_err());
        rows.get_mut("servers").unwrap().get_mut(&43).unwrap()["labels"] =
            json!({"fv-owner":"separate-runtime"});
        assert!(assess(&c, &rows, "eu-central").is_ok());
        c.provider.project_resource_ids.clear();
        rows.get_mut("servers").unwrap().remove(&43);
        c.provider
            .project_resource_ids
            .insert("firewalls".into(), vec![7]);
        for attachment in [
            json!({"type":"server","server":{"id":43}}),
            json!({"type":"label_selector","label_selector":{"selector":"tier=runtime"}}),
        ] {
            rows.get_mut("firewalls")
                .unwrap()
                .insert(7, json!({"id":7,"labels":{},"applied_to":[attachment]}));
            assert!(assess(&c, &rows, "eu-central").is_err());
        }
        rows.get_mut("firewalls").unwrap().clear();
        c.provider.project_resource_ids.clear();
        rows.get_mut("volumes")
            .unwrap()
            .insert(12, json!({"id":12,"server":43}));
        c.provider
            .project_resource_ids
            .insert("volumes".into(), vec![12]);
        assert!(assess(&c, &rows, "eu-central").is_err());
        rows.get_mut("volumes")
            .unwrap()
            .insert(12, json!({"id":12,"server":null}));
        assert!(assess(&c, &rows, "eu-central").is_ok());
        c.provider
            .project_resource_ids
            .insert("unknown-kind".into(), vec![1]);
        assert!(assess(&c, &rows, "eu-central").is_err());
    }

    #[test]
    fn storage_boxes_require_an_explicit_private_id_even_when_unassigned_or_labelled() {
        let mut c = config();
        let mut rows = fixture(&c);
        let box_id = 78;
        assert!(assess(&c, &rows, "eu-central").is_ok());
        rows.get_mut("storage_boxes").unwrap().insert(
            box_id,
            json!({
                "id":box_id, "server":null, "labels":{"fv-owner":c.project}
            }),
        );
        assert!(assess(&c, &rows, "eu-central").is_err());
        c.provider
            .project_resource_ids
            .insert("storage_boxes".into(), vec![79]);
        assert!(assess(&c, &rows, "eu-central").is_err());
        c.provider
            .project_resource_ids
            .insert("storage_boxes".into(), vec![box_id]);
        assert_eq!(
            assess(&c, &rows, "eu-central").unwrap().counts["storage_boxes"],
            1
        );
        rows.get_mut("storage_boxes").unwrap().clear();
        assert!(assess(&c, &rows, "eu-central").is_err());
    }

    #[test]
    fn live_request_path_uses_same_token_for_full_inventory_and_stops_before_mutation() {
        let c = config();
        let rows = fixture(&c);
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let writes = Arc::new(AtomicUsize::new(0));
        let redirects = Arc::new(AtomicUsize::new(0));
        let loop_running = running.clone();
        let loop_writes = writes.clone();
        let loop_redirects = redirects.clone();
        let worker = thread::spawn(move || {
            while loop_running.load(Ordering::Acquire) {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let lines: Vec<_> = BufReader::new(&stream)
                    .lines()
                    .map(Result::unwrap)
                    .take_while(|l| !l.is_empty())
                    .collect();
                let request: Vec<_> = lines[0].split_whitespace().collect();
                if request[0] != "GET" {
                    loop_writes.fetch_add(1, Ordering::SeqCst);
                }
                let token = lines
                    .iter()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("authorization: bearer ")
                            .map(str::to_owned)
                    })
                    .unwrap();
                if request[1] == "/redirect-target" {
                    loop_redirects.fetch_add(1, Ordering::SeqCst);
                    stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                    continue;
                }
                let (api, path) = request[1].trim_start_matches('/').split_once('/').unwrap();
                let (kind, query) = path.split_once('?').unwrap_or((path, ""));
                assert_eq!(
                    api,
                    if kind == "storage_boxes" {
                        "storage"
                    } else {
                        "cloud"
                    }
                );
                if kind == "storage_boxes" && token == "storage-denied" {
                    stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                    continue;
                }
                if kind == "storage_boxes" && token == "storage-redirect" {
                    write!(stream, "HTTP/1.1 302 Found\r\nLocation: http://{address}/redirect-target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                    continue;
                }
                assert!(!query.contains("selector"));
                let page = if query.contains("page=2&") { 2 } else { 1 };
                let index = match kind {
                    "images" if query.contains("type=backup") => "backups",
                    "images" if query.contains("type=snapshot") => "snapshots",
                    other => other,
                };
                let mut items: Vec<_> = if kind == "locations" {
                    vec![json!({"name":"hel1","network_zone":"eu-central"})]
                } else {
                    rows.get(index)
                        .map(|r| r.values().cloned().collect())
                        .unwrap_or_default()
                };
                let mut next = Value::Null;
                if kind == "storage_boxes" && token == "unassigned-box" {
                    items = vec![json!({"id":78,"server":null})];
                }
                if kind == "servers" {
                    match token.as_str() {
                        token if token.starts_with("candidate-") => {
                            items[0]["server_type"] =
                                json!({"name":"cx23","architecture":"x86","disk":40});
                            items[0]["image"] =
                                json!({"name":"ubuntu-24.04","architecture":"x86","type":"system"});
                            items[0]["primary_disk_size"] = json!(40);
                            items[0]["status"] = json!("running");
                            match token {
                                "candidate-wrong-arch" => {
                                    items[0]["image"]["architecture"] = json!("arm")
                                }
                                "candidate-nonstock" => {
                                    items[0]["image"]["type"] = json!("snapshot")
                                }
                                "candidate-unsupported" => {
                                    items[0]["image"]["name"] = json!("ubuntu-22.04")
                                }
                                "candidate-no-image-name" => {
                                    items[0]["image"]["name"] = Value::Null
                                }
                                "candidate-wrong-disk" => items[0]["primary_disk_size"] = json!(80),
                                "candidate-no-disk" => items[0]["primary_disk_size"] = Value::Null,
                                _ => (),
                            }
                        }
                        "wrong-project" => items[0]["id"] = json!(43),
                        "mixed-project" if page == 1 => next = json!(2),
                        "mixed-project" => {
                            items = vec![json!({"id":43, "name":"other-workload","labels":{}})]
                        }
                        "repeated-page" if page == 1 => next = json!(2),
                        "bad-pagination" => next = json!(1),
                        _ => (),
                    }
                }
                let body = json!({kind:items,"meta":{"pagination":{"page":page,"per_page":50,"next_page":next}}}).to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        let provider = |token: &str| {
            let mut provider =
                Hetzner::with_token(token.into(), Client::builder().no_proxy()).unwrap();
            assert_eq!(provider.endpoint, "https://api.hetzner.cloud/v1");
            assert_eq!(provider.storage_endpoint, "https://api.hetzner.com/v1");
            provider.endpoint = format!("http://{address}/cloud");
            provider.storage_endpoint = format!("http://{address}/storage");
            provider
        };
        let audited = provider("dedicated-project").audit(&c);
        let mut candidate: Value =
            serde_json::from_str(include_str!("../../../config/candidate.example.json")).unwrap();
        candidate["project"] = json!(c.project);
        candidate["provider"]["existing_server"] = json!(c.provider.existing_server);
        let mut candidate: ProviderCandidate = serde_json::from_value(candidate).unwrap();
        candidate.validate().unwrap();
        let x86 = provider("candidate-x86").existing_candidate(&candidate);
        let candidate_failures = [
            "candidate-wrong-arch",
            "candidate-nonstock",
            "candidate-unsupported",
            "candidate-no-image-name",
            "candidate-wrong-disk",
            "candidate-no-disk",
            "wrong-project",
        ]
        .map(|token| provider(token).existing_candidate(&candidate));
        candidate.provider.image = Some("ubuntu-26.04".into());
        let explicit_mismatch = provider("candidate-x86").existing_candidate(&candidate);
        candidate.provider.image = Some("ubuntu-24.04".into());
        let explicit_match = provider("candidate-x86").existing_candidate(&candidate);
        candidate.root_disk_gb = None;
        let optional_disk = provider("candidate-no-disk").existing_candidate(&candidate);
        let blocked: Vec<_> = [
            "wrong-project",
            "mixed-project",
            "repeated-page",
            "bad-pagination",
            "unassigned-box",
            "storage-denied",
            "storage-redirect",
        ]
        .map(|token| provider(token).apply(&c, None))
        .into_iter()
        .collect();
        running.store(false, Ordering::Release);
        worker.join().unwrap();
        let safe = audited.unwrap();
        assert_eq!(safe["project_isolated"], true);
        assert_eq!(safe["resources"]["servers"], 1);
        assert_eq!(safe["resources"]["storage_boxes"], 0);
        assert!(!safe.to_string().contains("203.0.113."));
        let x86 = x86.unwrap();
        assert_eq!(x86["platform"], "linux/amd64");
        assert_eq!(x86["location"], "hel1");
        assert_eq!(x86["server_type"], "cx23");
        assert_eq!(x86["image"], "ubuntu-24.04");
        assert_eq!(x86["root_disk_gb"], 40);
        assert_eq!(x86["running"], true);
        assert!(!x86.to_string().contains("203.0.113."));
        assert!(!x86.to_string().contains(&c.project));
        assert!(candidate_failures.iter().all(Result::is_err));
        assert!(explicit_mismatch.is_err());
        assert_eq!(explicit_match.unwrap(), x86);
        assert_eq!(optional_disk.unwrap()["root_disk_gb"], Value::Null);
        assert!(blocked.iter().all(Result::is_err));
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        assert_eq!(redirects.load(Ordering::SeqCst), 0);
    }
}
