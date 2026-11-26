use anyhow::{Context, Result, bail, ensure};
use fv_config::{Config, direct_subdomain, private_write};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    net::{Ipv6Addr, SocketAddr, UdpSocket},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

const RESOLVER: &str = "# Managed by Founder Village local-edge\nnameserver 127.0.0.1\nport 43853\nsearch_order 1\ntimeout 2\n";
const CA_PATH: &str = ".state/local/edge/root.crt";

pub fn routes(root: &Path, c: &Config) -> Result<BTreeMap<String, u16>> {
    ensure!(
        c.environment == "local" && c.project == "fv-local",
        "local-edge requires fv-local"
    );
    let routes: BTreeMap<String, u16> =
        serde_json::from_slice(&fs::read(root.join("config/local-domains.json"))?)?;
    ensure!(
        !routes.is_empty()
            && routes
                .iter()
                .all(|(host, port)| direct_subdomain(host, "fv") && *port >= 1024),
        "local domains must use one-level *.fv names and unprivileged loopback upstream ports"
    );
    ensure!(
        routes.get(&c.api_domain) == Some(&43801) && routes.get(&c.admin_domain) == Some(&43802),
        "local API/admin domains must match the upstream registry"
    );
    ensure!(
        routes.iter().all(|(host, port)| *port != 43803
            && host != "hasura.fv"
            && !host.starts_with("hasura-")),
        "Hasura is private; use the authenticated console inside admin.fv"
    );
    Ok(routes)
}

fn corefile() -> &'static str {
    // Only one label is allowed. Valid A/HTTPS/etc. questions get NODATA so
    // clients still try AAAA. Nested names and unrelated zones get NXDOMAIN.
    r#".:1053 {
    errors
    template IN ANY fv {
        match "^hasura(-[a-z0-9-]+)?\.fv\.$"
        rcode NXDOMAIN
        fallthrough
    }
    template IN AAAA fv {
        match "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.fv\.$"
        answer "{{ .Name }} 30 IN AAAA ::1"
        fallthrough
    }
    template IN ANY fv {
        match "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.fv\.$"
        rcode NOERROR
        fallthrough
    }
    template IN ANY {
        rcode NXDOMAIN
    }
}
"#
}

fn caddyfile(routes: &BTreeMap<String, u16>) -> String {
    let mut text = String::from(
        "{\n admin off\n auto_https disable_redirects\n skip_install_trust\n pki {\n  ca local {\n   name \"Founder Village Local Authority\"\n  }\n }\n servers {\n  protocols h1 h2\n }\n}\n",
    );
    // Clients may reject a wildcard directly under a private TLD. Issue exact
    // hostname certificates, and never enable unbounded on-demand issuance.
    text.push_str(
        &routes
            .keys()
            .map(|host| format!("https://{host}:8443"))
            .collect::<Vec<_>>()
            .join(", "),
    );
    text.push_str(" {\n tls internal\n");
    for (index, (host, port)) in routes.iter().enumerate() {
        if host == "vault.fv" {
            text.push_str(&super::vaultwarden::proxy_route(host));
            continue;
        }
        text.push_str(&format!(" @service{index} host {host}\n handle @service{index} {{\n  reverse_proxy host.docker.internal:{port}\n }}\n"));
    }
    text.push_str(" respond \"Unknown Founder Village hostname\" 404\n}\n");
    text
}

pub fn render(root: &Path, c: &Config) -> Result<()> {
    let routes = routes(root, c)?;
    let images = super::validate_images(root)?;
    let dir = root.join(".state/local/edge");
    let caddy = caddyfile(&routes);
    for (name, data) in [
        ("Caddyfile", caddy.clone()),
        ("Corefile", corefile().into()),
    ] {
        let path = dir.join(name);
        private_write(&path, data.as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644))?;
        }
    }
    let mount = |name: &str, target: &str| format!("{}:{target}:ro", dir.join(name).display());
    let mut compose = json!({
        "services": {
            "local-edge": {
                "labels": {"fv.local.config-sha256": fv_config::digest(caddy.as_bytes())},
                "image": images.get("caddy").context("Caddy image pin missing")?,
                "restart": "unless-stopped", "read_only": true, "cap_drop": ["ALL"],
                "security_opt": ["no-new-privileges:true"], "mem_limit": "128m", "pids_limit": 64,
                "ports": ["[::1]:443:8443"],
                "volumes": [mount("Caddyfile", "/etc/caddy/Caddyfile"), "local_edge_data:/data", "local_edge_config:/config"],
                "extra_hosts": ["host.docker.internal:host-gateway"]
            },
            "local-dns": {
                "labels": {"fv.local.config-sha256": fv_config::digest(corefile().as_bytes())},
                "image": images.get("coredns").context("CoreDNS image pin missing")?,
                "command": ["-conf", "/etc/fv/Corefile"], "user": "65532:65532",
                "restart": "unless-stopped", "read_only": true, "cap_drop": ["ALL"],
                "cap_add": ["NET_BIND_SERVICE"],
                "security_opt": ["no-new-privileges:true"], "mem_limit": "64m", "pids_limit": 64,
                "ports": ["127.0.0.1:43853:1053/udp", "127.0.0.1:43853:1053/tcp"],
                "volumes": [mount("Corefile", "/etc/fv/Corefile")]
            }
        },
        "volumes": {"local_edge_data": {}, "local_edge_config": {}}
    });
    let vault = images
        .get("vaultwarden")
        .context("Vaultwarden image pin missing")?;
    if let Some(service) = super::vaultwarden::workstation_service(root, vault)? {
        compose["services"]["vaultwarden"] = service;
        compose["services"]["local-edge"]["networks"] = json!(["default", "vaultwarden"]);
        compose["networks"]["vaultwarden"] = json!({"internal": true});
    }
    private_write(
        &dir.join("compose.json"),
        &serde_json::to_vec_pretty(&compose)?,
    )?;
    Ok(())
}

pub(crate) fn compose(root: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("docker");
    command
        .args(["compose", "--project-directory"])
        .arg(root)
        .args(["-p", "fv-local", "-f", ".state/local/edge/compose.json"])
        .args(args)
        .current_dir(root);
    command
}

pub fn up(root: &Path, c: &Config) -> Result<()> {
    fs::create_dir_all(root.join(".state"))?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join(".state/local-edge.lock"))?;
    fs2::FileExt::try_lock_exclusive(&lock).context("another local-edge operation is running")?;
    render(root, c)?;
    fv_host::run_command(
        &mut compose(root, &["up", "-d", "--wait", "--wait-timeout", "30"]),
        300,
    )?;
    for _ in 0..40 {
        let output = compose(
            root,
            &[
                "exec",
                "-T",
                "local-edge",
                "cat",
                "/data/caddy/pki/authorities/local/root.crt",
            ],
        )
        .output()?;
        if output.status.success() && output.stdout.starts_with(b"-----BEGIN CERTIFICATE-----") {
            let path = root.join(CA_PATH);
            if path.exists() {
                ensure!(
                    fs::read(path)? == output.stdout,
                    "local CA changed; refusing to replace the existing trust anchor automatically"
                );
            } else {
                private_write(&path, &output.stdout)?;
            }
            let ca = reqwest::Certificate::from_pem(&output.stdout)?;
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .add_root_certificate(ca)
                .resolve(&c.api_domain, SocketAddr::from((Ipv6Addr::LOCALHOST, 443)))
                .timeout(Duration::from_secs(1))
                .build()?;
            for _ in 0..40 {
                if dns_ready()
                    && client
                        .get(format!("https://{}/health/live", c.api_domain))
                        .send()
                        .is_ok_and(|r| r.status().is_success() || r.status().as_u16() == 502)
                {
                    println!(
                        "Local .fv DNS and TLS edge ready (application readiness is checked separately)."
                    );
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(250));
            }
            bail!(
                "local DNS/TLS edge failed its probe; inspect docker compose -p fv-local -f .state/local/edge/compose.json logs"
            );
        }
        thread::sleep(Duration::from_millis(250));
    }
    bail!(
        "local CA not ready; inspect docker compose -p fv-local -f .state/local/edge/compose.json logs"
    )
}

fn dns_ready() -> bool {
    let probe = || -> std::io::Result<bool> {
        let socket = UdpSocket::bind(("127.0.0.1", 0))?;
        socket.set_read_timeout(Some(Duration::from_millis(250)))?;
        socket.connect(("127.0.0.1", 43853))?;
        socket
            .send(b"FV\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x03api\x02fv\x00\x00\x1c\x00\x01")?;
        let mut response = [0; 512];
        let len = socket.recv(&mut response)?;
        Ok(len >= 12
            && &response[..2] == b"FV"
            && response[2] & 0x80 != 0
            && response[3] & 0xf == 0
            && response[7] > 0)
    };
    probe().unwrap_or(false)
}

pub fn plan(root: &Path, c: &Config) -> Result<()> {
    for (host, port) in routes(root, c)? {
        println!("https://{host} -> http://127.0.0.1:{port}");
    }
    println!(
        "\n*.fv DNS: 127.0.0.1:43853 (UDP/TCP), one-level AAAA ::1 only; nested names: NXDOMAIN.\nHTTPS: [::1]:443; private CA and containers belong to fv-local.\nmacOS setup installs /etc/resolver/fv and trusts the public CA in your login keychain.\nExisting IPv4 HTTPS services are preserved."
    );
    Ok(())
}

fn host_ready(c: &Config) -> bool {
    fs::read_to_string("/etc/resolver/fv").is_ok_and(|v| v == RESOLVER)
        && Command::new("/usr/bin/curl")
            .args([
                "--noproxy",
                "*",
                "--connect-timeout",
                "2",
                "--max-time",
                "5",
                "--silent",
                "--output",
                "/dev/null",
            ])
            .arg(format!("https://{}/health/live", c.api_domain))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
}

pub fn setup(root: &Path, c: &Config) -> Result<()> {
    plan(root, c)?;
    ensure!(
        std::env::consts::OS == "macos",
        "automatic split-DNS and trust installation currently supports macOS only"
    );
    up(root, c)?;
    if !fs::read_to_string("/etc/resolver/fv").is_ok_and(|v| v == RESOLVER) {
        let path = Path::new("/etc/resolver/fv");
        if path.exists() {
            ensure!(
                fs::read_to_string(path)? == RESOLVER,
                "/etc/resolver/fv is not managed by this runtime; refusing to overwrite it"
            );
        }
        let exe = std::env::current_exe()?;
        let shell_quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
        let command = format!(
            "{} --root {} local-edge host-install",
            shell_quote(exe.to_str().context("invalid binary path")?),
            shell_quote(root.to_str().context("invalid root path")?)
        );
        let script = format!(
            "do shell script {} with administrator privileges",
            serde_json::to_string(&command)?
        );
        println!(
            "macOS administrator authentication is required to install the scoped .fv resolver."
        );
        let status = Command::new("osascript").args(["-e", &script]).status()?;
        ensure!(
            status.success(),
            "host installation did not finish; run bin/fv local-edge setup again to complete macOS authentication"
        );
    }
    if !host_ready(c) {
        let keychain =
            Path::new(&std::env::var("HOME").context("user home required for login keychain")?)
                .join("Library/Keychains/login.keychain-db");
        println!("Installing Founder Village's public CA trust in your login keychain.");
        let status = Command::new("security")
            .args(["add-trusted-cert", "-r", "trustRoot", "-k"])
            .arg(keychain)
            .arg(root.join(CA_PATH))
            .status()?;
        ensure!(
            status.success(),
            "login-keychain trust was not authorized; open .state/local/edge/root.crt in Keychain Access, trust this CA for SSL, then run local-edge doctor"
        );
    }
    doctor(root, c)
}

pub fn host_install(root: &Path, c: &Config) -> Result<()> {
    routes(root, c)?;
    ensure!(std::env::consts::OS == "macos", "macOS required");
    ensure!(
        Command::new("id").arg("-u").output()?.stdout == b"0\n",
        "host-install requires administrator authentication; use local-edge setup"
    );
    let path = Path::new("/etc/resolver/fv");
    if path.exists() {
        ensure!(
            fs::read_to_string(path)? == RESOLVER,
            "refusing to overwrite an unmanaged resolver"
        );
    }
    private_write(path, RESOLVER.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o644))?;
    }
    for (program, args) in [
        ("dscacheutil", vec!["-flushcache"]),
        ("killall", vec!["-HUP", "mDNSResponder"]),
    ] {
        ensure!(
            Command::new(program).args(args).status()?.success(),
            "DNS cache refresh failed"
        );
    }
    println!(
        "Founder Village split-DNS resolver installed; existing host records and resolvers preserved."
    );
    Ok(())
}

pub fn doctor(root: &Path, c: &Config) -> Result<()> {
    let ca = reqwest::Certificate::from_pem(&fs::read(root.join(CA_PATH))?)?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .add_root_certificate(ca)
        .timeout(Duration::from_secs(5))
        .build()?;
    for (host, _) in routes(root, c)? {
        // A stopped upstream returns 502: that still proves DNS, hostname TLS and
        // the explicit proxy route, but never counts as service readiness.
        let response = client
            .get(format!("https://{host}/health/live"))
            .send()
            .with_context(|| format!("DNS/TLS probe failed for {host}; run local-edge setup"))?;
        ensure!(
            response.status().is_success() || response.status().as_u16() == 502,
            "unexpected edge response for {host}: {}",
            response.status()
        );
        println!(
            "{host}: DNS/TLS passed; upstream HTTP {}",
            response.status().as_u16()
        );
    }
    ensure!(
        host_ready(c),
        "current-user CA trust or macOS resolver is missing; run local-edge setup"
    );
    Ok(())
}

pub fn down(root: &Path, c: &Config) -> Result<()> {
    routes(root, c)?;
    fv_host::run_command(&mut compose(root, &["stop"]), 60)
}
