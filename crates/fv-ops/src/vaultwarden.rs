use anyhow::{Context, Result, ensure};
use fv_config::{Config, digest, private_write};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt, chown},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub(crate) const ARCHIVE: &str = "vaultwarden-data.tar.age";
const UID: u32 = 65532;

pub(crate) fn render(
    root: &Path,
    c: &Config,
    image: &str,
    admin_hash: Option<&str>,
    overlay: &mut Value,
) -> Result<()> {
    let domain = c
        .vaultwarden_domain
        .as_deref()
        .context("missing vault hostname")?;
    let path = format!(".state/{}/vaultwarden", c.environment);
    let dir = root.join(&path);
    if !dir.exists() {
        fs::DirBuilder::new().mode(0o700).create(&dir)?;
    }
    let meta = dir.symlink_metadata()?;
    ensure!(
        meta.is_dir() && meta.uid() == 0 && meta.mode() & 0o077 == 0,
        "unsafe Vaultwarden state directory"
    );
    let data = dir.join("data");
    if !data.exists() {
        fs::DirBuilder::new().mode(0o700).create(&data)?;
    }
    let meta = data.symlink_metadata()?;
    ensure!(
        meta.is_dir() && (meta.uid() == 0 || meta.uid() == UID) && meta.mode() & 0o077 == 0,
        "unsafe Vaultwarden data directory"
    );
    if meta.uid() != UID || meta.gid() != UID {
        chown(&data, Some(UID), Some(UID))?;
    }
    let operator = if let Some(hash) = admin_hash {
        ensure!(
            hash.starts_with("$argon2id$v=19$")
                && hash.len() <= 512
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"$=,+/-".contains(&b)),
            "Vaultwarden admin access requires an Argon2id PHC hash"
        );
        json!({"admin_token": hash})
    } else {
        json!({})
    };
    let bytes = serde_json::to_vec(&operator)?;
    let file = dir.join("config.json");
    private_write(&file, &bytes)?;
    chown(&file, None, Some(UID))?;
    fs::set_permissions(&file, fs::Permissions::from_mode(0o440))?;

    overlay["networks"]["vaultwarden"] = json!({"internal": true});
    overlay["services"]["caddy"]["networks"] = json!(["edge", "vaultwarden"]);
    overlay["services"]["vaultwarden"] = service_definition(
        image,
        &format!("./{path}"),
        domain,
        &format!("{UID}:{UID}"),
        &bytes,
    );
    Ok(())
}

fn service_definition(image: &str, path: &str, domain: &str, user: &str, config: &[u8]) -> Value {
    json!({
        "image": image,
        "profiles": ["vaultwarden"],
        "init": true,
        "user": user,
        "read_only": true,
        "tmpfs": ["/tmp:size=32m,noexec,nosuid,nodev"],
        "cap_drop": ["ALL"],
        "security_opt": ["no-new-privileges:true"],
        "restart": "unless-stopped",
        "stop_grace_period": "40s",
        "mem_limit": "384m",
        "pids_limit": 128,
        "networks": ["vaultwarden"],
        "volumes": [
            {"type": "bind", "source": format!("{path}/data"), "target": "/data",
                "bind": {"create_host_path": false}},
            {"type": "bind", "source": format!("{path}/config.json"),
                "target": "/run/vaultwarden/config.json", "read_only": true,
                "bind": {"create_host_path": false}}
        ],
        "labels": {"org.founder-village.vaultwarden.config": digest(config)},
        "environment": {
            "DOMAIN": format!("https://{domain}"),
            "CONFIG_FILE": "/run/vaultwarden/config.json",
            "ROCKET_PORT": "8080",
            "SIGNUPS_ALLOWED": "false",
            "INVITATIONS_ALLOWED": "false",
            "EMERGENCY_ACCESS_ALLOWED": "false",
            "DISABLE_ICON_DOWNLOAD": "true",
            "LOG_LEVEL": "off",
            "UMASK": "077"
        },
        "healthcheck": {
            "test": ["CMD", "curl", "--fail", "--silent", "--output", "/dev/null",
                "--max-time", "3", "http://127.0.0.1:8080/alive"],
            "interval": "5s", "timeout": "4s", "retries": 12, "start_period": "10s"
        }
    })
}

pub(crate) fn workstation_service(root: &Path, image: &str) -> Result<Option<Value>> {
    let binding = root.join(".state/local/edge/vault-home");
    let binding_meta = match binding.symlink_metadata() {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let user = Command::new("id").arg("-u").output()?;
    ensure!(
        binding_meta.is_file()
            && binding_meta.mode() & 0o077 == 0
            && user.status.success()
            && user.stdout == format!("{}\n", binding_meta.uid()).as_bytes(),
        "invalid workstation Vaultwarden binding"
    );
    let home = PathBuf::from(fs::read_to_string(&binding)?.trim());
    ensure!(
        home.is_absolute(),
        "workstation Vaultwarden home must be absolute"
    );
    let dir = home.join("bootstrap-vault");
    let meta = dir.symlink_metadata()?;
    ensure!(
        meta.is_dir() && meta.mode() & 0o077 == 0 && meta.uid() == binding_meta.uid(),
        "unsafe workstation Vaultwarden directory"
    );
    let config = dir.join("config.json");
    let config_meta = config.symlink_metadata()?;
    let forbidden_mode = if meta.uid() == 0 { 0o037 } else { 0o077 };
    ensure!(
        config_meta.is_file()
            && config_meta.uid() == meta.uid()
            && config_meta.mode() & forbidden_mode == 0,
        "unsafe workstation Vaultwarden configuration"
    );
    let (uid, gid) = if meta.uid() == 0 {
        (UID, UID)
    } else {
        (meta.uid(), meta.gid())
    };
    let data = dir.join("data");
    if !data.exists() {
        fs::DirBuilder::new().mode(0o700).create(&data)?;
        if meta.uid() == 0 {
            chown(&data, Some(uid), Some(gid))?;
        }
    }
    let data_meta = data.symlink_metadata()?;
    ensure!(
        data_meta.is_dir() && data_meta.uid() == uid && data_meta.mode() & 0o077 == 0,
        "unsafe workstation Vaultwarden data directory"
    );
    if meta.uid() == 0 {
        chown(&config, None, Some(gid))?;
        fs::set_permissions(&config, fs::Permissions::from_mode(0o440))?;
    }
    let mut service = service_definition(
        image,
        dir.to_str().context("invalid workstation vault path")?,
        "vault.fv",
        &format!("{uid}:{gid}"),
        &fs::read(&config)?,
    );
    service
        .as_object_mut()
        .context("invalid Vaultwarden service")?
        .remove("profiles");
    Ok(Some(service))
}

pub(crate) fn proxy_route(domain: &str) -> String {
    format!(
        r#"
 @vault host {domain}
 handle @vault {{
  header {{
   Cache-Control "no-store"
   defer
  }}
  @vaultAdmin path /admin*
  respond @vaultAdmin 404
  reverse_proxy vaultwarden:8080 {{
   header_up X-Real-IP {{http.request.header.CF-Connecting-IP}}
  }}
 }}
"#,
    )
}

pub fn start(root: &Path, c: &Config) -> Result<()> {
    if c.vaultwarden_domain.is_some() {
        super::compose(
            root,
            c,
            &[
                "up",
                "-d",
                "--no-deps",
                "--no-build",
                "--pull",
                "never",
                "--wait",
                "--wait-timeout",
                "90",
                "vaultwarden",
            ],
        )?;
    }
    Ok(())
}

fn admin_curl(root: &Path, c: &Config, args: &[&str], input: &[u8]) -> Result<String> {
    let mut command = vec![
        "exec",
        "-T",
        "vaultwarden",
        "curl",
        "--silent",
        "--max-time",
        "10",
        "--output",
        "/dev/null",
    ];
    command.extend_from_slice(args);
    let mut compose = if c.environment == "local" {
        super::local_edge::compose(root, &command)
    } else {
        super::compose_command(root, c, &command)
    };
    let mut child = compose
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let written = child
        .stdin
        .take()
        .context("vault request input missing")?
        .write_all(input);
    let result = child.wait_with_output()?;
    written?;
    ensure!(result.status.success(), "Vaultwarden admin request failed");
    Ok(String::from_utf8(result.stdout)?)
}

pub fn invite(root: &Path, c: &Config, input: impl Read) -> Result<()> {
    if c.environment != "local" {
        ensure!(c.vaultwarden_domain.is_some(), "Vaultwarden is disabled");
        ensure!(
            Path::new("/etc/fv-runtime-owner").is_file(),
            "Vaultwarden invitations require a converged runtime host"
        );
        fv_host::assert_owned_host(c)?;
    }
    let mut bytes = String::new();
    input.take(4097).read_to_string(&mut bytes)?;
    let (email, token) = bytes
        .trim_end_matches('\n')
        .split_once('\n')
        .context("expected the invite address and admin passphrase on stdin")?;
    ensure!(
        bytes.len() < 4097
            && email.len() <= 254
            && email.contains('@')
            && !email.chars().any(|c| c.is_control() || c.is_whitespace())
            && !token.is_empty()
            && !token.chars().any(char::is_control),
        "invalid vault invitation input"
    );
    let login = admin_curl(
        root,
        c,
        &[
            "--dump-header",
            "-",
            "--data-urlencode",
            "token@-",
            "http://127.0.0.1:8080/admin",
        ],
        token.as_bytes(),
    )?;
    let cookie = login
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            let cookie = value.trim().split(';').next()?;
            (name.eq_ignore_ascii_case("set-cookie") && cookie.starts_with("VW_ADMIN="))
                .then_some(cookie)
        })
        .context("Vaultwarden rejected the admin login")?;
    // Both the short-lived admin cookie and the address stay on stdin.
    let config = format!(
        "header = {}\nheader = \"Content-Type: application/json\"\ndata-binary = {}\n",
        serde_json::to_string(&format!("Cookie: {cookie}"))?,
        serde_json::to_string(&json!({"email": email}).to_string())?,
    );
    let response = admin_curl(
        root,
        c,
        &[
            "--config",
            "-",
            "--write-out",
            "%{http_code}",
            "http://127.0.0.1:8080/admin/invite",
        ],
        config.as_bytes(),
    )?;
    ensure!(response == "200", "Vaultwarden rejected the invitation");
    Ok(())
}

fn check_snapshot_tree(dir: &Path) -> Result<()> {
    ensure!(
        dir.symlink_metadata()?.is_dir(),
        "unsafe vault data directory"
    );
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            check_snapshot_tree(&entry.path())?;
        } else {
            ensure!(kind.is_file(), "unsupported file in vault backup");
        }
    }
    Ok(())
}

pub(crate) fn snapshot(root: &Path, c: &Config, output: &Path) -> Result<()> {
    let env = super::env(root, c)?;
    let recipient = env
        .get("AGE_RECIPIENT")
        .context("missing vault recovery recipient")?;
    ensure!(
        recipient.starts_with("age1")
            && recipient.len() == 62
            && recipient
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()),
        "invalid vault recovery recipient"
    );
    let data = root.join(format!(".state/{}/vaultwarden/data", c.environment));
    let temporary = output.with_extension(format!("pending-{}", fv_config::random_secret()));
    let capture = (|| -> Result<()> {
        super::compose(root, c, &["stop", "vaultwarden"])?;
        check_snapshot_tree(&data)?;
        ensure!(
            data.join("db.sqlite3").symlink_metadata()?.is_file(),
            "vault SQLite database missing"
        );
        // Wait for graceful shutdown before copying the database and associated
        // files. The pipeline keeps the unencrypted archive off disk.
        fv_host::run_command(
            Command::new("/bin/bash")
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .args([
                    "-e",
                    "-o",
                    "pipefail",
                    "-c",
                    r#"umask 077
tar -C "$1" --exclude=./icon_cache --exclude=./tmp -cf - . | age -r "$2" -o "$3""#,
                    "fv-vaultwarden-backup",
                ])
                .arg(&data)
                .arg(recipient)
                .arg(&temporary),
            900,
        )?;
        fs::rename(&temporary, output)?;
        Ok(())
    })();
    let resumed = start(root, c);
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    capture.context("Vaultwarden snapshot failed")?;
    resumed.context("Vaultwarden did not resume after the snapshot")
}
