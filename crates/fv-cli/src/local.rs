use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use fv_config::Config;
use signal_hook::{
    consts::signal::{SIGINT, SIGTERM},
    low_level::unregister,
};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    net::{SocketAddr, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const SERVICES: &[(&str, Option<u16>)] = &[
    ("api", Some(43801)),
    ("admin-api", Some(43802)),
    ("workers", Some(43805)),
    ("domain-worker", None),
    ("monitor", Some(43804)),
];

// Each invocation owns separate process groups. Never discover/kill processes by
// port, executable name or a persisted PID that may belong to a different run.
struct Children(Vec<(&'static str, Child)>);
impl Children {
    fn spawn(&mut self, name: &'static str, command: &mut Command) -> Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        self.0.push((
            name,
            command
                .stdin(Stdio::null())
                .spawn()
                .with_context(|| format!("could not start {name}"))?,
        ));
        Ok(())
    }

    fn check(&mut self) -> Result<()> {
        for (name, child) in &mut self.0 {
            if let Some(status) = child.try_wait()? {
                bail!("{name} exited ({status}); inspect .state/local/start/{name}.log");
            }
        }
        Ok(())
    }
}

fn signal(child: &Child, name: &str) {
    #[cfg(unix)]
    {
        let _ = Command::new("/bin/kill")
            .args([name, "--", &format!("-{}", child.id())])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(unix))]
    let _ = (child, name);
}

impl Drop for Children {
    fn drop(&mut self) {
        for (_, child) in &self.0 {
            signal(child, "-TERM");
        }
        let deadline = Instant::now() + Duration::from_secs(40);
        while Instant::now() < deadline {
            if self
                .0
                .iter_mut()
                .all(|(_, child)| child.try_wait().ok().flatten().is_some())
            {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        for (_, child) in &mut self.0 {
            signal(child, "-KILL");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub(crate) struct Interrupt {
    stopped: Arc<AtomicBool>,
    ids: Vec<signal_hook::SigId>,
}
impl Interrupt {
    pub(crate) fn new() -> Result<Self> {
        let mut guard = Self {
            stopped: Arc::new(AtomicBool::new(false)),
            ids: Vec::new(),
        };
        for signal in [SIGINT, SIGTERM] {
            guard
                .ids
                .push(signal_hook::flag::register(signal, guard.stopped.clone())?);
        }
        Ok(guard)
    }
    pub(crate) fn stopped(&self) -> bool {
        self.stopped.load(Ordering::Relaxed)
    }
}
impl Drop for Interrupt {
    fn drop(&mut self) {
        for id in self.ids.drain(..) {
            unregister(id);
        }
    }
}

fn fv(root: &Path, config: &Path) -> Result<Command> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--root")
        .arg(root)
        .arg("--config")
        .arg(config)
        .current_dir(root);
    Ok(command)
}

// Preserve only host execution basics, then add this service's private catalog.
// In particular, the admin never inherits provider write keys or Docker access
// variables from the operator's shell or the runtime's full secret catalog.
fn service_env(
    root: &Path,
    name: &str,
    catalog: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>> {
    let mut keys = vec!["FV_ENV".to_owned(), "FV_REVISION".into()];
    let auth = [
        "OIDC_ISSUER",
        "OIDC_AUDIENCE",
        "OIDC_JWKS_URL",
        "LOCAL_JWT_SECRET",
    ];
    match name {
        "api" => keys.extend(auth.map(str::to_owned)),
        "admin-api" => keys.extend(
            auth.into_iter()
                .chain([
                    "CONTROL_DATABASE_URL",
                    "ADMIN_ORIGIN",
                    "ROOT_ADMIN_ACTORS",
                    "HASURA_URL",
                    "HASURA_ADMIN_SECRET",
                    "CF_BINARY",
                    "CF_SHA256",
                    "CF_ACCOUNT_ID",
                    "CF_ZONE_ID",
                    "CF_ZONE_NAME",
                    "CF_MANAGED_NAMES",
                    "CF_READ_TOKEN",
                ])
                .map(str::to_owned),
        ),
        "workers" => keys.push("AMQP_URL".into()),
        "domain-worker" => keys.extend(
            [
                "RUNNER_DATABASE_URL",
                "ROOT_ADMIN_ACTORS",
                "CF_BINARY",
                "CF_SHA256",
                "CF_ACCOUNT_ID",
                "CF_ZONE_ID",
                "CF_ZONE_NAME",
                "CF_MANAGED_NAMES",
                "CF_READ_TOKEN",
                "CF_WRITE_TOKEN",
                "AUDIT_HMAC_KEY",
                "AUDIT_REGION",
                "AUDIT_ENDPOINT",
                "AUDIT_ACCESS_KEY",
                "AUDIT_SECRET_KEY",
                "AUDIT_BUCKET",
            ]
            .map(str::to_owned),
        ),
        "monitor" => keys.extend(
            [
                "MONITOR_CONTROL_DATABASE_URL",
                "MONITOR_TOKEN",
                "ALERT_WEBHOOK_URL",
            ]
            .map(str::to_owned),
        ),
        _ => bail!("unknown local service"),
    }
    let prefix = match name {
        "api" => Some(""),
        "workers" | "domain-worker" => Some("WORKER_"),
        "monitor" => Some("MONITOR_"),
        _ => None,
    };
    if let Some(prefix) = prefix {
        for app in fv_config::applications(root)? {
            keys.push(format!(
                "{prefix}{}_DATABASE_URL",
                app.id.replace('-', "_").to_uppercase()
            ));
        }
    }
    if name == "api" {
        keys.extend(["HASURA_URL", "HASURA_JWT_SECRET"].map(str::to_owned));
        keys.extend(
            catalog
                .keys()
                .filter(|k| k.starts_with("OBJECT_") || k.starts_with("MEMBERS_"))
                .cloned(),
        );
    }
    let mut vars: BTreeMap<String, String> = keys
        .into_iter()
        .filter_map(|k| catalog.get(&k).map(|v| (k, v.clone())))
        .collect();
    for key in ["PATH", "HOME", "TMPDIR", "SystemRoot"] {
        if let Ok(value) = std::env::var(key) {
            vars.insert(key.into(), value);
        }
    }
    vars.insert("BIND_HOST".into(), "127.0.0.1".into());
    if name == "domain-worker" || name == "admin-api" {
        vars.insert(
            "CF_WORK_DIR".into(),
            root.join(format!(".state/local/start/cf-{name}"))
                .to_string_lossy()
                .into_owned(),
        );
    }
    Ok(vars)
}

fn step(
    name: &'static str,
    command: &mut Command,
    timeout: u64,
    interrupt: &Interrupt,
) -> Result<bool> {
    if interrupt.stopped() {
        return Ok(false);
    }
    println!("\n{name}…");
    let mut children = Children(Vec::new());
    children.spawn(name, command)?;
    let deadline = Instant::now() + Duration::from_secs(timeout);
    loop {
        if interrupt.stopped() {
            return Ok(false);
        }
        if let Some(status) = children.0[0].1.try_wait()? {
            ensure!(status.success(), "{name} failed ({status})");
            return Ok(true);
        }
        ensure!(Instant::now() < deadline, "{name} timed out");
        thread::sleep(Duration::from_millis(100));
    }
}

pub fn run_service(root: &Path, c: &Config, name: &str) -> Result<()> {
    ensure!(
        c.environment == "local" && c.project == "fv-local",
        "dev services require fv-local"
    );
    let name = if name == "admin" { "admin-api" } else { name };
    let &(name, port) = SERVICES
        .iter()
        .find(|(service, _)| *service == name)
        .context("unknown local service")?;
    let env = service_env(root, name, &fv_ops::env(root, c)?)?;
    let mut command = Command::new("node");
    command
        .args(["--import", "tsx"])
        .arg(format!("services/{name}/main.ts"))
        .current_dir(root)
        .env_clear()
        .envs(env)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(port) = port {
        command.env("PORT", port.to_string());
    }
    let interrupt = Interrupt::new()?;
    let mut children = Children(Vec::new());
    children.spawn(name, &mut command)?;
    while !interrupt.stopped() {
        children.check()?;
        thread::sleep(Duration::from_millis(250));
    }
    Ok(())
}

pub fn run(root: &Path, config: &Path, c: &Config) -> Result<()> {
    ensure!(
        c.environment == "local" && c.project == "fv-local",
        "start local requires the local fv-local configuration"
    );
    ensure!(
        root.join("node_modules/tsx").is_dir(),
        "dependencies missing; run npm ci first"
    );
    fs::create_dir_all(root.join(".state"))?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(root.join(".state/local-start.lock"))?;
    FileExt::try_lock_exclusive(&lock).context("another local startup is already running")?;
    // Probe listeners rather than binding: closed sockets in TIME_WAIT must not
    // prevent an immediate restart. Never terminate a process that owns a port.
    for port in SERVICES.iter().filter_map(|(_, port)| *port) {
        match TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(250),
        ) {
            Ok(_) => bail!(
                "port {port} is already in use; leave the existing service running or stop it explicitly"
            ),
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {}
            Err(error) => {
                return Err(error).with_context(|| format!("could not check local port {port}"));
            }
        }
    }
    let interrupt = Interrupt::new()?;
    if !step(
        "Build console",
        Command::new("npm").args(["run", "build"]).current_dir(root),
        900,
        &interrupt,
    )? {
        println!("Startup cancelled; any started fv-local data containers are preserved.");
        return Ok(());
    }
    let setup = {
        let _lock = fv_ops::lock(root, c)?;
        crate::up::run(root, c, |command, timeout| {
            ensure!(
                step("Start data stack", command, timeout, &interrupt)?,
                "startup cancelled"
            );
            Ok(())
        })
    };
    if interrupt.stopped() {
        println!("Startup cancelled; any started fv-local data containers are preserved.");
        return Ok(());
    }
    setup?;
    fv_ops::local_edge::up(root, c)?;
    let catalog = fv_ops::env(root, c)?;
    ensure!(
        catalog.get("FV_ENV").is_some_and(|v| v == "local")
            && catalog
                .get("COMPOSE_PROJECT_NAME")
                .is_some_and(|v| v == "fv-local"),
        "local catalog environment/project mismatch"
    );
    let logs = root.join(".state/local/start");
    fs::create_dir_all(&logs)?;
    let mut children = Children(Vec::new());
    for &(name, port) in SERVICES {
        let mut command = Command::new("node");
        command
            .args(["--import", "tsx"])
            .arg(format!("services/{name}/main.ts"))
            .current_dir(root)
            .env_clear()
            .envs(service_env(root, name, &catalog)?);
        if let Some(port) = port {
            command.env("PORT", port.to_string());
        }
        logged(&logs, name, &mut command)?;
        children.spawn(name, &mut command)?;
    }
    let mut ops = fv(root, config)?;
    ops.arg("ops");
    logged(&logs, "ops", &mut ops)?;
    children.spawn("ops", &mut ops)?;
    let result = supervise(&mut children, &interrupt);
    println!(
        "\nStopping this session's servers; fv-local data containers and volumes are preserved."
    );
    drop(children);
    result
}

fn logged(logs: &Path, name: &str, command: &mut Command) -> Result<()> {
    let path = logs.join(format!("{name}.log"));
    fv_config::private_write(&path, b"")?;
    let log = OpenOptions::new().append(true).open(path)?;
    command
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    Ok(())
}

fn supervise(children: &mut Children, interrupt: &Interrupt) -> Result<()> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .build()?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut ready = false;
    while !interrupt.stopped() {
        children.check()?;
        if !ready {
            ready = [
                (43801, "ready"),
                (43802, "ready"),
                (43805, "ready"),
                (43804, "live"),
            ]
            .iter()
            .all(|(port, kind)| {
                client
                    .get(format!("http://127.0.0.1:{port}/health/{kind}"))
                    .send()
                    .is_ok_and(|r| r.status().is_success())
            });
            if ready {
                children.check()?;
                println!(
                    "\nLocal runtime ready.\n  Console: https://admin.fv\n  API:     https://api.fv\n  Sign in: bin/fv admin-login --open\n  Logs:    .state/local/start/*.log\n\nFirst use: bin/fv local-edge setup installs local DNS and CA trust.\nDirect loopback console: http://127.0.0.1:43802\nPress Ctrl-C to stop these servers. Use bin/fv down to stop the data stack."
                );
            } else {
                ensure!(
                    Instant::now() < deadline,
                    "local readiness timed out; inspect .state/local/start/*.log"
                );
            }
        }
        thread::sleep(Duration::from_millis(250));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_service_environment_excludes_host_and_writer_credentials() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let catalog = [
            ("FV_ENV", "local"),
            ("CONTROL_DATABASE_URL", "synthetic-admin"),
            ("CF_READ_TOKEN", "synthetic-read"),
            ("CF_WRITE_TOKEN", "synthetic-write"),
            ("BACKUP_S3_SECRET", "synthetic-backup"),
            ("RUNNER_DATABASE_URL", "synthetic-runner"),
            ("DOCKER_HOST", "synthetic-socket"),
            ("MEMBERS_STRIPE_KEY", "synthetic-members-provider"),
        ]
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .into();
        let vars = service_env(&root, "admin-api", &catalog).unwrap();
        assert_eq!(vars["CONTROL_DATABASE_URL"], "synthetic-admin");
        assert_eq!(vars["CF_READ_TOKEN"], "synthetic-read");
        let api = service_env(&root, "api", &catalog).unwrap();
        assert_eq!(api["MEMBERS_STRIPE_KEY"], "synthetic-members-provider");
        for key in [
            "CF_WRITE_TOKEN",
            "BACKUP_S3_SECRET",
            "RUNNER_DATABASE_URL",
            "DOCKER_HOST",
            "MEMBERS_STRIPE_KEY",
        ] {
            assert!(!vars.contains_key(key), "leaked {key}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_service_cleanup_stops_its_descendants_and_preserves_unrelated_processes() {
        let dir = std::env::temp_dir().join(fv_config::random_secret());
        fs::create_dir(&dir).unwrap();
        let mut unrelated = Command::new("/bin/sh")
            .args(["-c", "sleep 1; touch unrelated"])
            .current_dir(&dir)
            .spawn()
            .unwrap();
        let mut children = Children(Vec::new());
        children
            .spawn(
                "background",
                Command::new("/bin/sh")
                    .args(["-c", "(sleep 1; touch leaked) & touch started; wait"])
                    .current_dir(&dir),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !dir.join("started").exists() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        children
            .spawn("failed", Command::new("/bin/sh").args(["-c", "exit 7"]))
            .unwrap();
        loop {
            if let Err(error) = children.check() {
                assert!(error.to_string().contains("failed exited"));
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        drop(children);
        assert!(unrelated.wait().unwrap().success());
        assert!(dir.join("unrelated").exists());
        assert!(!dir.join("leaked").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
