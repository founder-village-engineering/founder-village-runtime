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
        super::backup::verify(root, c)?;
    }
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
    let state = root.join(format!(".state/{}", c.environment));
    let previous = fs::read_to_string(state.join("active-color"))?;
    let next = opposite_color(&previous)?;
    let mut env = super::env(root, c)?;
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
    let attempt = (|| -> Result<()> {
        super::compose(root, c, &["pull", &service])?;
        let labels = std::process::Command::new("docker")
            .args([
                "image",
                "inspect",
                "--format",
                "{{index .Config.Labels \"org.opencontainers.image.revision\"}}",
                &release.image,
            ])
            .output()?;
        ensure!(
            labels.status.success() && String::from_utf8(labels.stdout)?.trim() == release.revision,
            "image source revision mismatch"
        );
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
        super::compose(root, c, &["up", "-d", "--no-deps", &service])?;
        super::compose(root, c, &["up", "-d", "--no-deps", "admin", "caddy"])?;
        ready(
            if next == "blue" { 43811 } else { 43812 },
            &release.revision,
        )?;
        if env.contains_key(&format!("FV_API_{}_IMAGE", previous.trim().to_uppercase())) {
            private_write(&state.join("previous-color"), previous.trim().as_bytes())?;
        }
        private_write(&state.join("active-color"), next.as_bytes())?;
        super::render::render(root, c)?;
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
        )?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?;
        let status = client
            .get("http://127.0.0.1:43880/health/live")
            .header("Host", &c.api_domain)
            .send()?;
        ensure!(status.status().is_success(), "proxy postcheck failed");
        let served: serde_json::Value = status.json()?;
        ensure!(
            served["revision"] == release.revision,
            "serving revision mismatch"
        );
        super::compose(root, c, &["stop", "workers"])?;
        super::compose(root, c, &["up", "-d", "--no-deps", "workers"])?;
        Ok(())
    })();
    if attempt.is_err() {
        private_write(&state.join("active-color"), previous.trim().as_bytes())?;
        private_write(&file, &old_env)?;
        super::render::render(root, c)?;
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
        )?;
        let _ = super::compose(root, c, &["up", "-d", "--no-deps", "workers"]);
        return attempt;
    }
    private_write(&state.join("current-release"), id.as_bytes())?;
    let mut db = super::client(root, c)?;
    db.execute("INSERT INTO control.deployments(id,revision,manifest_hash,color,state) VALUES(gen_random_uuid(),$1,$2,$3,'serving')",&[&release.revision,&id,&next])?;
    super::record(root, c, "deploy.release", "succeeded")?;
    Ok(())
}
fn ready(port: u16, revision: &str) -> Result<()> {
    let client = reqwest::blocking::Client::builder()
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
    ready(
        if previous.trim() == "blue" {
            43811
        } else {
            43812
        },
        &revision,
    )?;
    let image = env
        .get(&format!("FV_API_{}_IMAGE", previous.trim().to_uppercase()))
        .context("no previous immutable artifact")?
        .clone();
    env.insert("FV_APP_IMAGE".into(), image);
    env.insert("FV_REVISION".into(), revision);
    private_write(
        &root.join(format!(".state/{}.env", c.environment)),
        env.iter()
            .map(|(k, v)| format!("{k}={v}\n"))
            .collect::<String>()
            .as_bytes(),
    )?;

    private_write(&state.join("active-color"), previous.trim().as_bytes())?;
    super::render::render(root, c)?;
    if let Err(e) = super::compose(
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
    ) {
        private_write(&state.join("active-color"), current.as_bytes())?;
        return Err(e);
    }
    private_write(&state.join("previous-color"), current.as_bytes())?;
    super::compose(root, c, &["stop", "workers"])?;
    super::compose(root, c, &["up", "-d", "--no-deps", "workers"])?;
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
