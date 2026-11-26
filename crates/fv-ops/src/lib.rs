pub mod backup;
pub mod deploy;
pub mod local_edge;
pub mod render;
pub mod runner;
pub mod vaultwarden;
pub mod wireguard;
pub mod workstation;
use anyhow::{Result, ensure};
use fs2::FileExt;
use fv_config::Config;
use std::{collections::BTreeMap, fs, path::Path};
pub fn env(root: &Path, c: &Config) -> Result<BTreeMap<String, String>> {
    fv_config::env_read(&root.join(format!(".state/{}.env", c.environment)))
}
pub fn compose(root: &Path, c: &Config, args: &[&str]) -> Result<()> {
    fv_host::run_command(&mut compose_command(root, c, args), 3600)
}
pub fn compose_command(root: &Path, c: &Config, args: &[&str]) -> std::process::Command {
    let mut a = vec![
        "compose",
        "--project-directory",
        root.to_str().unwrap(),
        "--env-file",
    ];
    let file = format!(".state/{}.env", c.environment);
    a.push(&file);
    a.extend(["-p", &c.project, "-f", "infra/compose/compose.yml"]);
    let overlay = format!(".state/{}/applications.compose.json", c.environment);
    if root.join(&overlay).exists() {
        a.extend(["-f", &overlay]);
    }
    a.extend(args);
    let mut command = if c.environment == "local" {
        std::process::Command::new("docker")
    } else {
        fv_host::host_docker()
    };
    command.args(a).current_dir(root);
    if c.environment != "local" {
        command.env(
            "DOCKER_DEFAULT_PLATFORM",
            format!("linux/{}", c.provider.architecture.oci()),
        );
    }
    command
}
pub fn lock(root: &Path, c: &Config) -> Result<fs::File> {
    fs::create_dir_all(root.join(".state"))?;
    let f = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join(format!(".state/{}.lock", c.environment)))?;
    f.try_lock_exclusive()?;
    Ok(f)
}
pub fn client(root: &Path, c: &Config) -> Result<postgres::Client> {
    let e = env(root, c)?;
    let url = e
        .get("RUNNER_DATABASE_URL")
        .ok_or_else(|| anyhow::anyhow!("runner DB missing"))?;
    Ok(postgres::Client::connect(url, postgres::NoTls)?)
}
pub fn record(root: &Path, c: &Config, event: &str, outcome: &str) -> Result<()> {
    let mut db = client(root, c)?;
    db.execute(
        "SELECT control.append_audit($1,$2,$3,$4,NULL)",
        &[&"operator-cli", &event, &c.environment, &outcome],
    )?;
    Ok(())
}
pub fn validate_images(root: &Path) -> Result<BTreeMap<String, String>> {
    let images: BTreeMap<String, String> =
        serde_json::from_slice(&fs::read(root.join("config/images.lock.json"))?)?;
    for image in images.values() {
        let (_, digest) = image
            .rsplit_once("@sha256:")
            .ok_or_else(|| anyhow::anyhow!("digest pin required"))?;
        ensure!(
            digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid image digest"
        );
    }
    Ok(images)
}
