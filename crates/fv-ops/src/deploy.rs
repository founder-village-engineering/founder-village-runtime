use anyhow::{Context, Result, ensure};
use fv_config::{Config, digest, private_write};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path, time::Duration};
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Release {
    pub revision: String,
    pub image: String,
    pub config_hash: String,
    pub migrations_hash: String,
    pub images_hash: String,
}

pub fn promote_installed(root: &Path, c: &Config, revision: &str) -> Result<()> {
    ensure!(
        !root.join(".git").exists(),
        "promotion requires a signed installation"
    );
    fv_host::assert_platform(c)?;
    ensure!(
        Path::new("/etc/fv-runtime-owner").is_file(),
        "converge the host before promoting the installed release"
    );
    fv_host::assert_owned_host(c)?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join(".state/source-manifest.json"))?)?;
    ensure!(
        manifest["version"] == 2 && manifest["revision"] == revision,
        "installed signed release does not match the requested revision"
    );
    let image = manifest["image"].as_str().context("missing signed image")?;
    let id = prepare(root, c, revision, image)?;
    deploy(root, c, &id)
}

pub fn prepare(root: &Path, c: &Config, revision: &str, image: &str) -> Result<String> {
    ensure!(
        revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit()),
        "exact git SHA required"
    );
    immutable_repository(image)?;
    if c.environment != "local" {
        if root.join(".git").exists() {
            let head = std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(root)
                .output()?;
            ensure!(
                head.status.success() && String::from_utf8(head.stdout)?.trim() == revision,
                "runtime checkout must match exact release revision"
            );
            let clean = std::process::Command::new("git")
                .args(["status", "--porcelain"])
                .current_dir(root)
                .output()?;
            ensure!(
                clean.status.success() && clean.stdout.is_empty(),
                "remote release requires a clean checkout"
            );
        } else {
            let manifest: serde_json::Value =
                serde_json::from_slice(&fs::read(root.join(".state/source-manifest.json"))?)?;
            ensure!(
                manifest["revision"] == revision,
                "installed signed source revision mismatch"
            );
            if manifest["version"] == 2 {
                ensure!(
                    manifest["image"] == image,
                    "image is outside the installed signed release"
                );
                ensure!(
                    manifest["binaries"][c.provider.architecture.oci()]
                        == digest(&fs::read(root.join("target/release/fv"))?),
                    "installed native CLI does not match the signed release"
                );
            } else {
                ensure!(
                    manifest["version"] == 1
                        && c.provider.architecture == fv_config::Architecture::Amd64,
                    "installed source manifest does not support this platform"
                );
            }
            for entry in manifest["files"]
                .as_array()
                .context("missing signed source inventory")?
            {
                let relative = Path::new(entry["path"].as_str().context("invalid source path")?);
                ensure!(
                    relative
                        .components()
                        .all(|p| matches!(p, std::path::Component::Normal(_))),
                    "unsafe source path"
                );
                let file = root.join(relative);
                ensure!(
                    !file.symlink_metadata()?.file_type().is_symlink()
                        && digest(&fs::read(file)?)
                            == entry["sha256"].as_str().context("missing source hash")?,
                    "installed source drift"
                );
            }
        }
    }
    let migrations = tree_hash(root, &["database"])?;
    let r = Release {
        revision: revision.into(),
        image: image.into(),
        config_hash: config_hash(root, c)?,
        migrations_hash: migrations,
        images_hash: digest(&fs::read(root.join("config/images.lock.json"))?),
    };
    let body = serde_json::to_vec(&r)?;
    let id = digest(&body);
    private_write(&root.join(format!(".state/releases/{id}.json")), &body)?;
    Ok(id)
}
pub fn deploy(root: &Path, c: &Config, id: &str) -> Result<()> {
    ensure!(
        id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid release ID"
    );
    let bytes = fs::read(root.join(format!(".state/releases/{id}.json")))?;
    ensure!(digest(&bytes) == id, "release altered");
    let release: Release = serde_json::from_slice(&bytes)?;
    ensure!(
        release.config_hash == config_hash(root, c)?,
        "release configuration changed"
    );
    let new_id = prepare(root, c, &release.revision, &release.image)?;
    ensure!(new_id == id, "release input drift");
    if c.environment != "local" {
        fv_host::assert_platform(c)?;
        ensure!(
            !c.cloudflare.access_aud.is_empty(),
            "configure the Cloudflare Access audience before promotion"
        );
        super::backup::verify(root, c)?;
    }
    let arch = fv_host::docker_architecture()?;
    ensure!(
        c.environment == "local" || arch == c.provider.architecture,
        "Docker architecture does not match this host manifest"
    );
    let policy: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("policies/release.json"))?)?;
    approved_image(
        &release.image,
        policy["registryPrefix"]
            .as_str()
            .context("missing registry policy")?,
    )?;
    fv_host::run(
        "cosign",
        &[
            "verify",
            "--certificate-identity-regexp",
            policy["identityPattern"]
                .as_str()
                .context("missing signer identity")?,
            "--certificate-oidc-issuer",
            policy["issuer"].as_str().context("missing signer issuer")?,
            &release.image,
        ],
        root,
        &BTreeMap::new(),
        120,
    )?;
    fv_host::run(
        "docker",
        &[
            "pull",
            "--platform",
            &format!("linux/{}", arch.oci()),
            &release.image,
        ],
        root,
        &BTreeMap::new(),
        300,
    )?;
    let labels = std::process::Command::new("docker")
        .args([
            "image", "inspect", "--format",
            "{{.Os}}/{{.Architecture}} {{index .Config.Labels \"org.opencontainers.image.revision\"}}",
            &release.image,
        ])
        .output()?;
    ensure!(
        labels.status.success()
            && std::str::from_utf8(&labels.stdout)?.trim()
                == format!("linux/{} {}", arch.oci(), release.revision),
        "image platform or source revision mismatch"
    );
    let state = root.join(format!(".state/{}", c.environment));
    let previous = fs::read_to_string(state.join("active-color"))?;
    let next = opposite_color(&previous)?;
    let mut env = super::env(root, c)?;
    if fs::read_to_string(state.join("current-release")).is_ok_and(|current| current == id)
        && env.get(&format!("FV_API_{}_IMAGE", previous.trim().to_uppercase()))
            == Some(&release.image)
        && env.get(&format!(
            "FV_API_{}_REVISION",
            previous.trim().to_uppercase()
        )) == Some(&release.revision)
    {
        return check_proxy(c, &release.revision);
    }
    env.insert("FV_APP_IMAGE".into(), release.image.clone());
    env.insert(
        format!("FV_API_{}_IMAGE", next.to_uppercase()),
        release.image.clone(),
    );
    env.insert("FV_REVISION".into(), release.revision.clone());
    env.insert(
        format!("FV_API_{}_REVISION", next.to_uppercase()),
        release.revision.clone(),
    );
    env.entry("FV_ADMIN_IMAGE".into())
        .or_insert_with(|| release.image.clone());
    let file = root.join(format!(".state/{}.env", c.environment));
    let old_env = fs::read(&file)?;
    private_write(
        &file,
        env.iter()
            .map(|(k, v)| format!("{k}={v}\n"))
            .collect::<String>()
            .as_bytes(),
    )?;
    let service = format!("api-{next}");
    let previous_exists =
        env.contains_key(&format!("FV_API_{}_IMAGE", previous.trim().to_uppercase()));
    let mut cutover = false;
    let mut workers_replaced = false;
    let attempt = (|| -> Result<()> {
        fv_host::run(
            "node",
            &["--import", "tsx", "packages/database/migrate.ts"],
            root,
            &env,
            120,
        )?;
        fv_host::run(
            "node",
            &["--import", "tsx", "scripts/hasura.ts"],
            root,
            &env,
            120,
        )?;
        start(root, c, &[&service, "admin", "caddy"])?;
        ready(
            if next == "blue" { 43811 } else { 43812 },
            &release.revision,
        )?;
        private_write(&state.join("active-color"), next.as_bytes())?;
        cutover = true;
        super::render::render(root, c)?;
        reload_proxy(root, c)?;
        check_proxy(c, &release.revision)?;
        workers_replaced = true;
        super::compose(root, c, &["stop", "workers"])?;
        start(root, c, &["workers"])?;
        Ok(())
    })();
    if let Err(failure) = attempt {
        private_write(&state.join("active-color"), previous.trim().as_bytes())?;
        private_write(&file, &old_env)?;
        super::render::render(root, c)?;
        if cutover && previous_exists {
            reload_proxy(root, c).context("failed to restore previous proxy route")?;
        }
        if workers_replaced && previous_exists {
            start(root, c, &["workers"]).context("failed to restore previous workers")?;
        }
        if !previous_exists {
            super::compose(root, c, &["stop", &service, "admin", "caddy", "workers"])?;
        }
        return Err(failure);
    }
    if previous_exists {
        private_write(&state.join("previous-color"), previous.trim().as_bytes())?;
    }
    private_write(&state.join("current-release"), id.as_bytes())?;
    let mut db = super::client(root, c)?;
    db.execute("INSERT INTO control.deployments(id,revision,manifest_hash,color,state) VALUES(gen_random_uuid(),$1,$2,$3,'serving')",&[&release.revision,&id,&next])?;
    super::record(root, c, "deploy.release", "succeeded")?;
    Ok(())
}

fn start(root: &Path, c: &Config, services: &[&str]) -> Result<()> {
    let mut args = vec![
        "up",
        "-d",
        "--no-deps",
        "--no-build",
        "--wait",
        "--wait-timeout",
        "90",
    ];
    args.extend_from_slice(services);
    super::compose(root, c, &args)
}

fn reload_proxy(root: &Path, c: &Config) -> Result<()> {
    super::compose(
        root,
        c,
        &[
            "exec",
            "-T",
            "caddy",
            "caddy",
            "reload",
            "--config",
            "/etc/caddy/Caddyfile",
        ],
    )
}

fn check_proxy(c: &Config, revision: &str) -> Result<()> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()?;
    for host in [&c.api_domain, &c.admin_domain] {
        let response = client
            .get("http://127.0.0.1:43880/health/ready")
            .header("Host", host)
            .send()?;
        ensure!(
            response.status().is_success(),
            "proxy readiness check failed"
        );
    }
    let response = client
        .get("http://127.0.0.1:43880/health/live")
        .header("Host", &c.api_domain)
        .send()?
        .error_for_status()?;
    let served: serde_json::Value = response.json()?;
    ensure!(served["revision"] == revision, "serving revision mismatch");
    Ok(())
}

fn active_release(root: &Path, c: &Config) -> Result<(String, String)> {
    let state = root.join(format!(".state/{}", c.environment));
    ensure!(
        state.join("current-release").is_file(),
        "no promoted release"
    );
    let value = fs::read_to_string(state.join("active-color"))?;
    let color = value.trim();
    opposite_color(color)?;
    let env = super::env(root, c)?;
    let policy: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("policies/release.json"))?)?;
    let prefix = policy["registryPrefix"]
        .as_str()
        .context("missing registry policy")?;
    for key in [
        format!("FV_API_{}_IMAGE", color.to_uppercase()),
        "FV_ADMIN_IMAGE".into(),
        "FV_APP_IMAGE".into(),
    ] {
        approved_image(env.get(&key).context("missing promoted image")?, prefix)?;
    }
    let revision = env
        .get(&format!("FV_API_{}_REVISION", color.to_uppercase()))
        .context("missing promoted revision")?;
    ensure!(
        revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid promoted revision"
    );
    Ok((format!("api-{color}"), revision.clone()))
}

pub fn resume(root: &Path, c: &Config) -> Result<()> {
    if root
        .join(format!(".state/{}/current-release", c.environment))
        .exists()
    {
        let (service, revision) = active_release(root, c)?;
        start(root, c, &[&service, "admin", "caddy", "workers"])?;
        check_proxy(c, &revision)?;
    }
    Ok(())
}

pub fn check_serving(root: &Path, c: &Config) -> Result<String> {
    let (_, revision) = active_release(root, c)?;
    check_proxy(c, &revision)?;
    Ok(revision)
}
fn ready(port: u16, revision: &str) -> Result<()> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()?;
    for _ in 0..60 {
        if let Ok(r) = client
            .get(format!("http://127.0.0.1:{port}/health/ready"))
            .send()
            && r.status().is_success()
        {
            let live: serde_json::Value = client
                .get(format!("http://127.0.0.1:{port}/health/live"))
                .send()?
                .json()?;
            ensure!(live["revision"] == revision, "candidate revision mismatch");
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    anyhow::bail!("candidate did not become ready")
}
pub fn rollback(root: &Path, c: &Config) -> Result<()> {
    let state = root.join(format!(".state/{}", c.environment));
    let previous =
        fs::read_to_string(state.join("previous-color")).context("no rollback target")?;
    ensure!(
        ["blue", "green"].contains(&previous.trim()),
        "invalid rollback state"
    );
    let current = fs::read_to_string(state.join("active-color"))?;
    opposite_color(&current)?;
    ensure!(
        current.trim() != previous.trim(),
        "rollback target is already active"
    );
    let mut env = super::env(root, c)?;
    let revision = env
        .get(&format!(
            "FV_API_{}_REVISION",
            previous.trim().to_uppercase()
        ))
        .context("no previous verified revision")?
        .clone();
    let image = env
        .get(&format!("FV_API_{}_IMAGE", previous.trim().to_uppercase()))
        .context("no previous immutable artifact")?
        .clone();
    let policy: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("policies/release.json"))?)?;
    approved_image(
        &image,
        policy["registryPrefix"]
            .as_str()
            .context("missing registry policy")?,
    )?;
    let service = format!("api-{}", previous.trim());
    start(root, c, &[&service])?;
    ready(
        if previous.trim() == "blue" {
            43811
        } else {
            43812
        },
        &revision,
    )?;
    env.insert("FV_APP_IMAGE".into(), image);
    env.insert("FV_REVISION".into(), revision.clone());
    let file = root.join(format!(".state/{}.env", c.environment));
    let old_env = fs::read(&file)?;
    private_write(
        &file,
        env.iter()
            .map(|(k, v)| format!("{k}={v}\n"))
            .collect::<String>()
            .as_bytes(),
    )?;

    let attempt = (|| -> Result<()> {
        private_write(&state.join("active-color"), previous.trim().as_bytes())?;
        super::render::render(root, c)?;
        reload_proxy(root, c)?;
        check_proxy(c, &revision)?;
        super::compose(root, c, &["stop", "workers"])?;
        start(root, c, &["workers"])
    })();
    if let Err(failure) = attempt {
        private_write(&state.join("active-color"), current.trim().as_bytes())?;
        private_write(&file, &old_env)?;
        super::render::render(root, c)?;
        reload_proxy(root, c).context("failed to restore current proxy route")?;
        start(root, c, &["workers"]).context("failed to restore current workers")?;
        return Err(failure);
    }
    private_write(&state.join("previous-color"), current.trim().as_bytes())?;
    super::record(root, c, "deploy.rollback", "succeeded")?;
    Ok(())
}

fn config_hash(root: &Path, c: &Config) -> Result<String> {
    let mut b = serde_json::to_vec(c)?;
    b.extend(
        tree_hash(
            root,
            &[
                "hasura",
                "policies",
                "config/applications.json",
                "config/tools.lock.json",
            ],
        )?
        .as_bytes(),
    );
    Ok(digest(&b))
}
fn tree_hash(root: &Path, paths: &[&str]) -> Result<String> {
    fn walk(root: &Path, path: &Path, bytes: &mut Vec<u8>) -> Result<()> {
        let meta = path.symlink_metadata()?;
        ensure!(
            !meta.file_type().is_symlink(),
            "release inputs cannot be symlinks"
        );
        if meta.is_dir() {
            let mut entries = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                walk(root, &e.path(), bytes)?;
            }
        } else {
            ensure!(meta.is_file(), "release inputs must be regular files");
            bytes.extend(path.strip_prefix(root)?.to_string_lossy().as_bytes());
            bytes.push(0);
            bytes.extend(digest(&fs::read(path)?).as_bytes());
        }
        Ok(())
    }
    let mut bytes = vec![];
    for p in paths {
        walk(root, &root.join(p), &mut bytes)?;
    }
    Ok(digest(&bytes))
}

fn opposite_color(value: &str) -> Result<&'static str> {
    match value.trim() {
        "blue" => Ok("green"),
        "green" => Ok("blue"),
        _ => anyhow::bail!("invalid active deployment color"),
    }
}
fn immutable_repository(image: &str) -> Result<&str> {
    let (repository, hash) = image
        .split_once("@sha256:")
        .context("immutable image required")?;
    ensure!(
        !repository.is_empty()
            && repository.contains('/')
            && repository
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-._/:".contains(&b))
            && repository
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..")
            && hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid immutable image"
    );
    Ok(repository)
}
fn approved_image(image: &str, prefix: &str) -> Result<()> {
    let expected = prefix
        .strip_suffix("@sha256:")
        .context("registry policy must bind an exact repository")?;
    ensure!(
        immutable_repository(image)? == expected,
        "image outside approved registry"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn immutable_images_require_exact_repository_and_digest() {
        let hash = "a".repeat(64);
        let prefix = "ghcr.io/example/runtime@sha256:";
        assert!(approved_image(&format!("{prefix}{hash}"), prefix).is_ok());
        for repository in [
            "ghcr.io/example/runtime-evil",
            "ghcr.io/example/runtime/evil",
            "ghcr.io/example/runtime@sha256:x",
            "ghcr.io/example/../runtime",
            "ghcr.io/example/runtime\n",
        ] {
            assert!(approved_image(&format!("{repository}@sha256:{hash}"), prefix).is_err());
        }
        assert!(approved_image(&format!("{prefix}{hash}"), "ghcr.io/example/runtime").is_err());
        assert!(
            immutable_repository(&format!(
                "ghcr.io/example/runtime@sha256:{}",
                "z".repeat(64)
            ))
            .is_err()
        );
        assert!(immutable_repository("ghcr.io/example/runtime:latest").is_err());
    }
    #[test]
    fn invalid_colors_cannot_choose_a_deployment_target() {
        assert_eq!(opposite_color("blue\n").unwrap(), "green");
        assert_eq!(opposite_color("green").unwrap(), "blue");
        for color in ["", "red", "BLUE", "blue green"] {
            assert!(opposite_color(color).is_err());
        }
    }
    #[cfg(unix)]
    #[test]
    fn release_tree_rejects_nonregular_files() {
        use std::os::unix::net::UnixListener;
        let root = std::path::PathBuf::from("/tmp")
            .join(format!("fv-release-{}", &fv_config::random_secret()[..16]));
        fs::create_dir(&root).unwrap();
        let socket = UnixListener::bind(root.join("socket")).unwrap();
        assert!(
            tree_hash(&root, &["socket"])
                .unwrap_err()
                .to_string()
                .contains("regular files")
        );
        drop(socket);
        fs::remove_dir_all(root).unwrap();
    }
}
