use anyhow::{Result, ensure};
use fv_config::{Config, identifier, private_write};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};
#[derive(Clone, Serialize, Deserialize)]
pub struct Peer {
    pub name: String,
    pub public_key: String,
    pub address: String,
    pub expires_at: String,
    pub enabled: bool,
}
pub fn peers(root: &Path, c: &Config) -> Result<Vec<Peer>> {
    let file = root.join(format!(".state/{}/peers.json", c.environment));
    if !file.exists() {
        return Ok(vec![]);
    }
    Ok(serde_json::from_slice(&fs::read(file)?)?)
}
pub fn enroll(
    root: &Path,
    c: &Config,
    name: &str,
    key: &str,
    address: &str,
    expiry: &str,
) -> Result<()> {
    ensure!(
        identifier(name)
            && key.len() == 44
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='),
        "invalid peer identity"
    );
    let ip: std::net::Ipv4Addr = address.parse()?;
    let network: ipnet::Ipv4Net = c.wireguard_cidr.parse()?;
    ensure!(
        network.contains(&ip)
            && ip != network.network()
            && ip != network.broadcast()
            && Some(ip) != network.hosts().next(),
        "invalid management address"
    );
    ensure!(
        expiry.len() == 10 && expiry.bytes().all(|b| b.is_ascii_digit() || b == b'-'),
        "expiry must be YYYY-MM-DD"
    );
    let expiry = chrono::NaiveDate::parse_from_str(expiry, "%Y-%m-%d")?;
    ensure!(
        expiry > chrono::Utc::now().date_naive(),
        "peer expiry must be in the future"
    );
    let expiry = expiry.to_string();
    let mut list = peers(root, c)?;
    ensure!(
        !list
            .iter()
            .any(|p| p.name != name && (p.public_key == key || p.address == address)),
        "peer identity collision"
    );
    if let Some(p) = list.iter_mut().find(|p| p.name == name) {
        ensure!(
            p.public_key == key && p.address == address,
            "peer drift: revoke before reenrollment"
        );
        p.enabled = true;
        p.expires_at = expiry.clone();
    } else {
        list.push(Peer {
            name: name.into(),
            public_key: key.into(),
            address: address.into(),
            expires_at: expiry.clone(),
            enabled: true,
        });
    }
    private_write(
        &root.join(format!(".state/{}/peers.json", c.environment)),
        &serde_json::to_vec_pretty(&list)?,
    )?;
    render(root, c, &list)
}
pub fn revoke(root: &Path, c: &Config, name: &str) -> Result<()> {
    let mut list = peers(root, c)?;
    let p = list
        .iter_mut()
        .find(|p| p.name == name)
        .ok_or_else(|| anyhow::anyhow!("peer not found"))?;
    p.enabled = false;
    private_write(
        &root.join(format!(".state/{}/peers.json", c.environment)),
        &serde_json::to_vec_pretty(&list)?,
    )?;
    render(root, c, &list)?;
    Ok(())
}
fn render(root: &Path, c: &Config, list: &[Peer]) -> Result<()> {
    let network: ipnet::Ipv4Net = c.wireguard_cidr.parse()?;
    let gateway = network
        .hosts()
        .next()
        .ok_or_else(|| anyhow::anyhow!("management network has no hosts"))?;
    let mut text = format!(
        "[Interface]\nAddress = {gateway}/{}\nListenPort = {}\n",
        network.prefix_len(),
        c.wireguard_port
    );
    let path = root.join(format!(".state/{}/wireguard.key", c.environment));
    if !path.exists() {
        let output = std::process::Command::new("wg").arg("genkey").output()?;
        ensure!(output.status.success(), "key generation failed");
        private_write(&path, &output.stdout)?;
    }
    let key = fs::read_to_string(path)?;
    text.push_str(&format!("PrivateKey = {}\n", key.trim()));
    for p in list.iter().filter(|p| {
        p.enabled
            && chrono::NaiveDate::parse_from_str(&p.expires_at, "%Y-%m-%d")
                .is_ok_and(|d| d > chrono::Utc::now().date_naive())
    }) {
        text.push_str(&format!(
            "\n[Peer]\nPublicKey = {}\nAllowedIPs = {}/32\n",
            p.public_key, p.address
        ));
    }
    private_write(
        &root.join(format!(".state/{}/wg-fv.conf", c.environment)),
        text.as_bytes(),
    )?;
    let mut db = super::client(root, c)?;
    for p in list {
        let enabled = p.enabled
            && chrono::NaiveDate::parse_from_str(&p.expires_at, "%Y-%m-%d")
                .is_ok_and(|d| d > chrono::Utc::now().date_naive());
        db.execute("INSERT INTO control.wireguard_peers(name,public_key,address,enabled,expires_at) VALUES($1,$2,$3::text::inet,$4,$5::text::timestamptz) ON CONFLICT(name) DO UPDATE SET public_key=$2,address=$3::text::inet,enabled=$4,expires_at=$5::text::timestamptz",&[&p.name,&p.public_key,&p.address,&enabled,&p.expires_at])?;
    }

    Ok(())
}
pub fn apply(root: &Path, c: &Config) -> Result<()> {
    ensure!(
        std::env::consts::OS == "linux",
        "WireGuard host apply requires Linux"
    );
    render(root, c, &peers(root, c)?)?;
    let source = root.join(format!(".state/{}/wg-fv.conf", c.environment));
    fv_host::run(
        "install",
        &[
            "-m",
            "600",
            source.to_str().unwrap(),
            "/etc/wireguard/wg-fv.conf",
        ],
        root,
        &BTreeMap::new(),
        30,
    )?;
    fv_host::run(
        "systemctl",
        &["enable", "--now", "wg-quick@wg-fv"],
        root,
        &BTreeMap::new(),
        30,
    )?;
    fv_host::run(
        "ufw",
        &[
            "allow", "in", "on", "wg-fv", "to", "any", "port", "22", "proto", "tcp",
        ],
        root,
        &BTreeMap::new(),
        30,
    )?;
    fv_host::run(
        "bash",
        &["-c", "wg syncconf wg-fv <(wg-quick strip wg-fv)"],
        root,
        &BTreeMap::new(),
        30,
    )
}
