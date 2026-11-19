use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub environment: String,
    pub project: String,
    pub api_domain: String,
    pub admin_domain: String,
    pub ssh_cidrs: Vec<String>,
    pub wireguard_cidr: String,
    pub wireguard_port: u16,
    pub provider: Provider,
    pub cloudflare: Cloudflare,
    pub backup: Backup,
    pub auth: Auth,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provider {
    pub name: String,
    pub location: String,
    pub server_type: String,
    pub image: String,
    pub ssh_key_ids: Vec<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cloudflare {
    pub account_id: String,
    pub zone_id: String,
    pub zone_name: String,
    pub managed_names: Vec<String>,
    pub access_team: String,
    pub access_aud: String,
    pub cf_binary: String,
    pub cf_sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Backup {
    pub retention_days: u32,
    pub rpo_seconds: u32,
    pub rto_seconds: u32,
    pub s3_endpoint: String,
    pub bucket: String,
    pub region: String,
    pub immutable_copy_confirmed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Auth {
    pub issuer: String,
    pub audience: String,
    pub jwks_url: String,
    pub client_id: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub root_actors: Vec<String>,
}

pub fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}
pub fn domain(s: &str) -> bool {
    s.len() < 254 && s.contains('.') && s.split('.').all(identifier)
}
pub fn direct_subdomain(host: &str, zone: &str) -> bool {
    domain(host)
        && (domain(zone) || zone == "fv")
        && host
            .strip_suffix(&format!(".{zone}"))
            .is_some_and(identifier)
}
pub fn validate_owned_url(value: &str, zone: &str) -> Result<()> {
    for candidate in value.split(',') {
        if let Ok(url) = url::Url::parse(candidate.trim())
            && let Some(host) = url.host_str()
        {
            let host = host.trim_end_matches('.');
            ensure!(
                host != "fv.test" && !host.ends_with(".fv.test"),
                "legacy .fv.test names must be replaced with one-level .fv names"
            );
            for root in ["fv", zone] {
                if host == root || host.ends_with(&format!(".{root}")) {
                    ensure!(
                        host == root || direct_subdomain(host, root),
                        "nested Founder Village URL host forbidden: {host}"
                    );
                }
            }
        }
    }
    Ok(())
}
fn https_endpoint(value: &str) -> bool {
    if value.chars().any(|c| c.is_control() || c.is_whitespace()) || value.contains('\\') {
        return false;
    }
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    value.strip_prefix("https://").is_some_and(|rest| {
        !rest.is_empty()
            && !rest.starts_with(['/', '?', '#'])
            && !rest
                .split(['/', '?', '#'])
                .next()
                .unwrap_or("")
                .contains('@')
    }) && url.scheme() == "https"
        && url.host_str().is_some_and(|host| !host.is_empty())
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn random_secret() -> String {
    (0..32)
        .map(|_| format!("{:02x}", rand::random::<u8>()))
        .collect()
}
pub fn load(path: &Path) -> Result<Config> {
    let c: Config = serde_json::from_slice(&fs::read(path)?)?;
    c.validate()?;
    Ok(c)
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            ["local", "staging", "production"].contains(&self.environment.as_str()),
            "invalid environment"
        );
        ensure!(identifier(&self.project), "invalid project");
        ensure!(
            (self.environment == "local") == (self.project == "fv-local"),
            "local resources require the fv-local project; remote resources must use a different project"
        );
        ensure!(
            domain(&self.api_domain)
                && domain(&self.admin_domain)
                && self.api_domain != self.admin_domain,
            "invalid or overlapping domains"
        );
        let zone = if self.environment == "local" {
            "fv"
        } else {
            &self.cloudflare.zone_name
        };
        ensure!(
            direct_subdomain(&self.api_domain, zone) && direct_subdomain(&self.admin_domain, zone),
            "API and admin must be one-level subdomains of {zone}"
        );
        for endpoint in [
            &self.auth.issuer,
            &self.auth.jwks_url,
            &self.auth.authorization_endpoint,
            &self.auth.token_endpoint,
            &self.backup.s3_endpoint,
        ] {
            validate_owned_url(endpoint, &self.cloudflare.zone_name)?;
        }
        for actor in &self.auth.root_actors {
            validate_owned_url(
                actor.split('|').next().unwrap_or(""),
                &self.cloudflare.zone_name,
            )?;
        }
        let vpn: ipnet::Ipv4Net = self
            .wireguard_cidr
            .parse()
            .context("invalid WireGuard CIDR")?;
        ensure!(
            vpn.prefix_len() > 0 && vpn.prefix_len() < 31 && self.wireguard_port >= 1024,
            "unsafe WireGuard configuration"
        );
        for cidr in &self.ssh_cidrs {
            let net: ipnet::IpNet = cidr.parse().context("invalid SSH CIDR")?;
            ensure!(net.prefix_len() > 0, "world-open SSH forbidden");
        }
        ensure!(self.provider.name == "hetzner", "unsupported provider");
        for s in [&self.provider.location, &self.provider.server_type] {
            ensure!(identifier(s), "invalid provider selection");
        }
        ensure!(
            self.provider.image.len() < 64
                && self
                    .provider
                    .image
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.'),
            "invalid OS image"
        );
        ensure!(
            self.backup.retention_days >= 30
                && self.backup.rpo_seconds > 0
                && self.backup.rto_seconds > 0,
            "unsafe recovery targets"
        );
        for name in &self.cloudflare.managed_names {
            ensure!(
                direct_subdomain(name, &self.cloudflare.zone_name),
                "managed DNS records must be one-level subdomains of the zone"
            );
        }
        if self.environment != "local" {
            ensure!(
                !self.provider.ssh_key_ids.is_empty() && !self.ssh_cidrs.is_empty(),
                "bootstrap SSH keys and CIDRs required"
            );
            for id in [&self.cloudflare.account_id, &self.cloudflare.zone_id] {
                ensure!(
                    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()),
                    "Cloudflare IDs required"
                );
            }
            ensure!(
                self.cloudflare.cf_sha256.len() == 64
                    && self
                        .cloudflare
                        .cf_sha256
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit())
                    && self.cloudflare.cf_binary.starts_with('/')
                    && !self.cloudflare.cf_binary.chars().any(char::is_control),
                "pinned cf binary required"
            );
            for u in [
                &self.auth.issuer,
                &self.auth.jwks_url,
                &self.auth.authorization_endpoint,
                &self.auth.token_endpoint,
                &self.backup.s3_endpoint,
            ] {
                ensure!(https_endpoint(u), "HTTPS provider endpoint required");
            }
            ensure!(
                !self.auth.client_id.is_empty()
                    && !self.auth.audience.is_empty()
                    && !self.backup.bucket.is_empty(),
                "identity and backup provider required"
            );
            ensure!(
                self.backup.immutable_copy_confirmed,
                "independent immutable backup custody must be configured"
            );
            ensure!(
                identifier(&self.cloudflare.access_team),
                "Access configuration required"
            );
        }
        Ok(())
    }
}
pub fn private_write(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        bail!("refusing symlink destination");
    }
    let tmp = path.with_extension(format!("tmp-{}", random_secret()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(&tmp)?;
    f.write_all(data)?;
    f.sync_all()?;
    fs::rename(tmp, path)?;
    Ok(())
}
pub fn env_read(path: &Path) -> Result<BTreeMap<String, String>> {
    let mut vars = BTreeMap::new();
    for line in fs::read_to_string(path)?.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (k, v) = line.split_once('=').context("invalid environment line")?;
        ensure!(
            !k.is_empty()
                && k.bytes().enumerate().all(|(i, b)| {
                    b.is_ascii_uppercase() || b == b'_' || (i > 0 && b.is_ascii_digit())
                })
                && !v.chars().any(char::is_control),
            "invalid environment key or control character"
        );
        ensure!(!vars.contains_key(k), "duplicate environment key");
        vars.insert(k.to_owned(), v.to_owned());
    }
    Ok(vars)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn denies_injection() {
        assert!(!identifier("x; reboot"));
        assert!(!domain("a.example.com/"));
        assert!(domain("api.example.com"));
    }
    #[test]
    fn founder_village_domains_are_exactly_one_level_deep() {
        assert!(direct_subdomain("api.fv", "fv"));
        assert!(direct_subdomain("api-dev.example.com", "example.com"));
        for host in [
            "fv",
            "dev.api.fv",
            "api.fv.test",
            "*.fv",
            "-api.fv",
            "api..fv",
        ] {
            assert!(!direct_subdomain(host, "fv"), "accepted {host}");
        }
        let mut config: Config =
            serde_json::from_str(include_str!("../../../config/local.json")).unwrap();
        for host in ["dev.api.fv", "api.fv.test"] {
            config.api_domain = host.into();
            assert!(config.validate().is_err());
        }
        config.api_domain = "api.fv".into();
        config.cloudflare.managed_names = vec!["api.dev.example.com".into()];
        assert!(config.validate().is_err());
        config.cloudflare.managed_names = vec!["api-dev.example.com".into()];
        config.auth.issuer = "https://login.local.fv".into();
        assert!(config.validate().is_err());
        for invalid in [
            "https://login.api.fv",
            "https://files.dev.example.com/",
            "https://local.fv.test",
            "https://login.api.fv./",
        ] {
            assert!(validate_owned_url(invalid, "example.com").is_err());
        }
        assert!(
            validate_owned_url(
                "https://files.example.com,https://third.party.invalid/",
                "example.com"
            )
            .is_ok()
        );
    }
    #[test]
    fn projects_cannot_cross_local_boundary() {
        let mut config: Config =
            serde_json::from_str(include_str!("../../../config/local.json")).unwrap();
        assert!(config.validate().is_ok());
        config.project = "unrelated-project".into();
        assert!(config.validate().is_err());
        config.environment = "production".into();
        config.project = "fv-local".into();
        assert!(
            config
                .validate()
                .unwrap_err()
                .to_string()
                .contains("local resources")
        );
    }
    #[test]
    fn endpoints_reject_parser_ambiguities_and_credentials() {
        for invalid in [
            "https://",
            "https:///example.com",
            "https://example.com/#secret",
            "https://user:password@example.com",
            "https://@example.com",
            "https://example.com\n/path",
            "https://example.com\\@evil.test",
            "https://example.com:99999",
            "http://example.com",
        ] {
            assert!(!https_endpoint(invalid), "accepted {invalid:?}");
        }
        assert!(https_endpoint(
            "https://identity.example.com/oidc?version=1"
        ));
        assert!(https_endpoint("https://[::1]:8443/oidc"));
    }
    #[test]
    fn env_catalog_rejects_invalid_keys_and_controls() {
        let file = std::env::temp_dir().join(random_secret());
        for invalid in [
            "=x",
            "A-B=x",
            "1KEY=x",
            "KEY=x\u{0}y",
            "KEY=x\t",
            "KEY=x\nKEY=y",
        ] {
            fs::write(&file, invalid).unwrap();
            assert!(env_read(&file).is_err(), "accepted {invalid:?}");
        }
        fs::write(&file, "# comment\nFV_ENV=local\nKEY_2=a=b\n").unwrap();
        assert_eq!(env_read(&file).unwrap()["KEY_2"], "a=b");
        fs::remove_file(file).unwrap();
    }
    #[test]
    fn private_file_rejects_link() {
        let dir = std::env::temp_dir().join(random_secret());
        fs::create_dir(&dir).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/tmp/no-touch", dir.join("link")).unwrap();
            assert!(private_write(&dir.join("link"), b"x").is_err());
        }
        fs::remove_dir_all(dir).unwrap();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Application {
    pub id: String,
    pub database: String,
    #[serde(rename = "hasuraSource")]
    pub hasura_source: String,
    pub owner: String,
}
pub fn applications(root: &Path) -> Result<Vec<Application>> {
    let list: Vec<Application> =
        serde_json::from_slice(&fs::read(root.join("config/applications.json"))?)?;
    ensure!(!list.is_empty(), "application registry empty");
    let mut ids = std::collections::HashSet::new();
    let mut dbs = std::collections::HashSet::new();
    let mut sources = std::collections::HashSet::new();
    for a in &list {
        ensure!(
            identifier(&a.id)
                && identifier(&a.database)
                && identifier(&a.hasura_source)
                && a.id.len() <= 40,
            "invalid namespace"
        );
        ensure!(
            ids.insert(&a.id) && dbs.insert(&a.database) && sources.insert(&a.hasura_source),
            "duplicate namespace"
        );
    }
    Ok(list)
}
