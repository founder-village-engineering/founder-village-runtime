use anyhow::{Context, Result, ensure};
use fv_config::{Config, digest, private_write};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, time::Duration};
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
    let manifest = super::workstation::Manifest::retained(root, revision, c.provider.architecture)?;
    let generation = root.join(".fv-releases").join(revision);
    manifest.verify_source(&generation)?;
    manifest.load_images(root)?;
    let current = super::workstation::Manifest::installed(root, c.provider.architecture)?.revision;
    let cfg = root
        .join(".state/private-config")
        .join(format!("{}.private.json", c.environment));
    let pending = root.join(format!(
        ".state/{}/pending-config/{revision}.json",
        c.environment
    ));
    let candidate_path = promotion_config(
        &cfg,
        &pending,
        &generation,
        &c.environment,
        &current,
        revision,
    );
    let candidate = fv_config::load(&candidate_path)?;
    ensure!(
        candidate.environment == c.environment
            && candidate.project == c.project
            && candidate.provider.architecture == c.provider.architecture,
        "candidate configuration crosses target boundary"
    );
    let previous_cfg = fs::read(&cfg)?;
    // Before changing any existing runtime selection, verify the running data
    // has its independently validated immutable backup.
    super::backup::verify(root, c)?;
    let attempt = (|| -> Result<()> {
        switch_host(root, &cfg, Some(revision), &fs::read(candidate_path)?)?;
        if candidate.vaultwarden_domain.is_some() {
            super::render::render(root, &candidate)?;
        }
        if c.vaultwarden_domain.is_none() && candidate.vaultwarden_domain.is_some() {
            super::vaultwarden::start(root, &candidate)?;
            super::backup::capture(root, &candidate, "full")?;
        }
        let id = prepare(root, &candidate, revision, &manifest.image)?;
        deploy(root, &candidate, &id)
    })();
    if let Err(e) = attempt {
        let stop_vault = if c.vaultwarden_domain.is_none() && candidate.vaultwarden_domain.is_some()
        {
            super::compose(root, &candidate, &["stop", "vaultwarden"])
        } else {
            Ok(())
        };
        switch_host(root, &cfg, Some(&current), &previous_cfg)?;
        super::render::render(root, c)?;
        stop_vault?;
        return Err(e);
    }
    if pending.exists() {
        fs::remove_file(pending)?;
    }
    Ok(())
}

fn promotion_config(
    live: &Path,
    pending: &Path,
    generation: &Path,
    environment: &str,
    current: &str,
    requested: &str,
) -> std::path::PathBuf {
    // Explicitly staged changes take precedence. First launch must preserve
    // Access IDs reconciled after installation and before enabling ingress.
    if pending.is_file() {
        pending.into()
    } else if current == requested {
        live.into()
    } else {
        generation
            .join(".bundle")
            .join(format!("{environment}.config"))
    }
}
fn switch_host(
    root: &Path,
    config: &Path,
    revision: Option<&str>,
    new_config: &[u8],
) -> Result<()> {
    let prior = fs::read(config)?;
    private_write(config, new_config)?;
    if let Some(rev) = revision
        && let Err(e) = super::workstation::select_generation(root, rev)
    {
        private_write(config, &prior)?;
        return Err(e);
    }
    Ok(())
}

pub fn prepare(root: &Path, c: &Config, revision: &str, image: &str) -> Result<String> {
    ensure!(
        revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit()),
        "exact git SHA required"
    );
    let source = if c.environment == "local" {
        immutable_repository(image)?;
        root.to_path_buf()
    } else {
        let manifest = super::workstation::Manifest::installed(root, c.provider.architecture)?;
        ensure!(
            manifest.revision == revision && manifest.image == image,
            "release differs from the signed installation"
        );
        let generation = root.join(".fv-current");
        manifest.verify_source(&generation)?;
        generation
    };
    let migrations = tree_hash(&source, &["database"])?;
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
    ensure!(
        c.environment != "local",
        "promote a signed installation on its bound host"
    );
    let installed = super::workstation::Manifest::installed(root, c.provider.architecture)?;
    ensure!(
        installed.image == release.image && installed.revision == release.revision,
        "candidate image mismatch"
    );
    installed.load_images(root)?;
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
        super::vaultwarden::start(root, c)?;
        check_proxy(c, &release.revision)?;
        return verify_containers(
            root,
            c,
            &format!("api-{}", previous.trim()),
            &release.revision,
        );
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
    env.insert("FV_ADMIN_IMAGE".into(), release.image.clone());
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
        start(root, c, &[&service])?;
        ready(
            if next == "blue" { 43811 } else { 43812 },
            &release.revision,
        )?;
        super::vaultwarden::start(root, c)?;
        start(root, c, &["admin", "caddy"])?;
        private_write(&state.join("active-color"), next.as_bytes())?;
        cutover = true;
        super::render::render(root, c)?;
        reload_proxy(root, c)?;
        check_proxy(c, &release.revision)?;
        workers_replaced = true;
        super::compose(root, c, &["stop", "workers"])?;
        start(root, c, &["workers"])?;
        verify_containers(root, c, &service, &release.revision)?;
        let mut db = super::client(root, c)?;
        let mut tx = db.transaction()?;
        let written=tx.execute("INSERT INTO control.deployments(id,revision,manifest_hash,color,state) SELECT gen_random_uuid(),$1,$2,$3,'serving' WHERE NOT EXISTS (SELECT 1 FROM control.deployments WHERE manifest_hash=$2 AND color=$3 AND state='serving')",&[&release.revision,&id,&next])?;
        if written > 0 {
            tx.execute(
                "SELECT control.append_audit($1,$2,$3,$4,NULL)",
                &[
                    &"operator-cli",
                    &"deploy.release",
                    &c.environment,
                    &"succeeded",
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    })();
    if let Err(failure) = attempt {
        private_write(&state.join("active-color"), previous.trim().as_bytes())?;
        private_write(&file, &old_env)?;
        super::render::render(root, c)?;
        if previous_exists {
            start(root, c, &["admin"])?;
        }
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
    private_write(
        &state.join(format!("config-{next}.json")),
        &serde_json::to_vec(c)?,
    )?;
    if previous_exists {
        if let Ok(old_id) = fs::read(state.join("current-release")) {
            private_write(&state.join("previous-release"), &old_id)?;
        }
        private_write(&state.join("previous-color"), previous.trim().as_bytes())?;
    }
    private_write(&state.join("current-release"), id.as_bytes())?;
    Ok(())
}

fn start(root: &Path, c: &Config, services: &[&str]) -> Result<()> {
    let mut args = vec![
        "up",
        "-d",
        "--no-deps",
        "--no-build",
        "--pull",
        "never",
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
    if let Some(vault) = &c.vaultwarden_domain {
        let response = client
            .get("http://127.0.0.1:43880/alive")
            .header("Host", vault)
            .send()?;
        ensure!(
            response.status().is_success(),
            "vault proxy readiness failed"
        );
        let response = client
            .get("http://127.0.0.1:43880/admin")
            .header("Host", vault)
            .send()?;
        ensure!(
            response.status() == reqwest::StatusCode::NOT_FOUND,
            "vault proxy exposed its admin path"
        );
    }
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
    let revision = env
        .get(&format!("FV_API_{}_REVISION", color.to_uppercase()))
        .context("missing promoted revision")?;
    for key in [
        format!("FV_API_{}_IMAGE", color.to_uppercase()),
        "FV_ADMIN_IMAGE".into(),
        "FV_APP_IMAGE".into(),
    ] {
        let image = env.get(&key).context("missing promoted image")?;
        verified_running(
            root,
            c,
            image,
            if key == "FV_ADMIN_IMAGE" {
                None
            } else {
                Some(revision)
            },
        )?;
    }
    ensure!(
        revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid promoted revision"
    );
    Ok((format!("api-{color}"), revision.clone()))
}

// A pre-v3 deployment may be the first rollback target during an in-place
// upgrade. Admit only a digest recorded in its original content-addressed
// deployment receipt and already present locally. Never fetch a legacy image.
fn verified_running(
    root: &Path,
    c: &Config,
    image: &str,
    revision: Option<&str>,
) -> Result<Option<String>> {
    if let Some(rev) = image.strip_prefix("fv-runtime:local-") {
        ensure!(
            revision.is_none_or(|r| r == rev),
            "running revision differs from signed image"
        );
        let m = super::workstation::Manifest::retained(root, rev, c.provider.architecture)?;
        ensure!(m.image == image, "unexpected signed image");
        m.load_images(root)?;
        return Ok(Some(rev.into()));
    }
    approved_image(
        image,
        "ghcr.io/founder-village-engineering/founder-village-runtime@sha256:",
    )?;
    let mut known = false;
    for file in fs::read_dir(root.join(".state/releases"))? {
        let file = file?;
        if !file.file_type()?.is_file() {
            continue;
        }
        let bytes = fs::read(file.path())?;
        if file.path().file_stem().and_then(|x| x.to_str()) != Some(&digest(&bytes)) {
            continue;
        }
        let release: Release = serde_json::from_slice(&bytes)?;
        if release.image == image && revision.is_none_or(|r| r == release.revision) {
            let mut db = super::client(root, c)?;
            if db.query_opt("SELECT 1 FROM control.deployments WHERE manifest_hash=$1 AND revision=$2 AND state='serving' LIMIT 1", &[&digest(&bytes),&release.revision])?.is_some() {known=true;break;}
        }
    }
    ensure!(known, "legacy image lacks original deployment evidence");
    let output = fv_host::host_docker()
        .args([
            "image",
            "inspect",
            "--format",
            "{{.Os}}/{{.Architecture}}",
            image,
        ])
        .output()?;
    ensure!(
        output.status.success()
            && std::str::from_utf8(&output.stdout)?.trim()
                == format!("linux/{}", c.provider.architecture.oci()),
        "legacy rollback image is unavailable locally"
    );
    Ok(None)
}

fn verify_containers(root: &Path, c: &Config, api: &str, revision: &str) -> Result<()> {
    let env = super::env(root, c)?;
    for (service, key) in [
        (
            api,
            format!("FV_{}_IMAGE", api.replace('-', "_").to_uppercase()),
        ),
        ("admin", "FV_ADMIN_IMAGE".into()),
        ("workers", "FV_APP_IMAGE".into()),
    ] {
        let tag = env.get(&key).context("missing serving image binding")?;
        let Some(rev) = tag.strip_prefix("fv-runtime:local-") else {
            continue;
        };
        ensure!(rev == revision, "serving containers use different releases");
        let m = super::workstation::Manifest::retained(root, rev, c.provider.architecture)?;
        let image = &m.images["app"];
        let out = fv_host::host_docker()
            .args([
                "container",
                "inspect",
                "--format",
                "{{.State.Running}} {{.Image}} {{.Config.Image}}",
                &format!("{}-{service}-1", c.project),
            ])
            .output()?;
        let stdout = std::str::from_utf8(&out.stdout)?;
        let fields: Vec<_> = stdout.split_whitespace().collect();
        ensure!(
            out.status.success()
                && fields.len() == 3
                && fields[0] == "true"
                && (fields[1] == image.id || fields[1] == image.manifest_id)
                && fields[2] == image.tag,
            "serving container differs from signed release"
        );
    }
    Ok(())
}

pub fn resume(root: &Path, c: &Config) -> Result<()> {
    if root
        .join(format!(".state/{}/current-release", c.environment))
        .exists()
    {
        let (service, revision) = active_release(root, c)?;
        start(root, c, &[&service, "admin", "caddy", "workers"])?;
        check_proxy(c, &revision)?;
        verify_containers(root, c, &service, &revision)?;
    }
    Ok(())
}

pub fn check_serving(root: &Path, c: &Config) -> Result<String> {
    let (service, revision) = active_release(root, c)?;
    check_proxy(c, &revision)?;
    verify_containers(root, c, &service, &revision)?;
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
    let generation = verified_running(root, c, &image, Some(&revision))?;
    if let Some(rev) = &generation {
        let manifest = super::workstation::Manifest::retained(root, rev, c.provider.architecture)?;
        manifest.verify_archive(&root.join(".fv-releases").join(rev))?;
        manifest.verify_source(&root.join(".fv-releases").join(rev))?;
    }
    let original = super::workstation::Manifest::installed(root, c.provider.architecture)?.revision;
    let active_config = root
        .join(".state/private-config")
        .join(format!("{}.private.json", c.environment));
    let old_config = fs::read(&active_config)?;
    let prior_config = state.join(format!("config-{}.json", previous.trim()));
    let target_config = if prior_config.exists() {
        fv_config::load(&prior_config)?
    } else {
        c.clone()
    };
    ensure!(
        target_config.project == c.project
            && target_config.environment == c.environment
            && target_config.provider.architecture == c.provider.architecture,
        "rollback configuration crosses target boundary"
    );
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
    env.insert("FV_ADMIN_IMAGE".into(), image.clone());
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
        switch_host(
            root,
            &active_config,
            generation.as_deref(),
            &serde_json::to_vec(&target_config)?,
        )?;
        private_write(&state.join("active-color"), previous.trim().as_bytes())?;
        super::render::render(root, &target_config)?;
        start(root, c, &["admin", "caddy"])?;
        reload_proxy(root, c)?;
        check_proxy(&target_config, &revision)?;
        super::compose(root, c, &["stop", "workers"])?;
        start(root, c, &["workers"])?;
        verify_containers(root, &target_config, &service, &revision)
    })();
    if let Err(failure) = attempt {
        switch_host(root, &active_config, Some(&original), &old_config)?;
        private_write(&state.join("active-color"), current.trim().as_bytes())?;
        private_write(&file, &old_env)?;
        super::render::render(root, c)?;
        start(root, c, &["admin", "caddy"])?;
        reload_proxy(root, c).context("failed to restore current proxy route")?;
        start(root, c, &["workers"]).context("failed to restore current workers")?;
        return Err(failure);
    }
    if let (Ok(active_id), Ok(prior_id)) = (
        fs::read(state.join("current-release")),
        fs::read(state.join("previous-release")),
    ) {
        private_write(&state.join("current-release"), &prior_id)?;
        private_write(&state.join("previous-release"), &active_id)?;
    }
    private_write(&state.join("previous-color"), current.trim().as_bytes())?;
    super::record(root, c, "deploy.rollback", "succeeded")?;
    Ok(())
}

fn config_hash(root: &Path, c: &Config) -> Result<String> {
    let source = if root.join(".fv-current").is_symlink() {
        root.join(".fv-current")
    } else {
        root.to_path_buf()
    };
    let mut paths = vec![
        "hasura",
        "config/applications.json",
        "config/tools.lock.json",
    ];
    if source.join("policies").exists() {
        paths.push("policies");
    }
    let mut b = serde_json::to_vec(c)?;
    b.extend(tree_hash(&source, &paths)?.as_bytes());
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
    #[cfg(unix)]
    #[test]
    fn first_launch_and_staged_config_follow_the_operational_source_and_rollback_together() {
        let root = std::env::temp_dir().join(format!(
            "fv-config-generation-{}",
            fv_config::random_secret()
        ));
        let first = "a".repeat(40);
        let second = "b".repeat(40);
        let first_dir = root.join(".fv-releases").join(&first);
        let second_dir = root.join(".fv-releases").join(&second);
        fs::create_dir_all(first_dir.join(".bundle")).unwrap();
        fs::create_dir_all(second_dir.join(".bundle")).unwrap();
        let live = root.join("active-config");
        let pending = root.join("pending-config");
        fs::write(
            first_dir.join(".bundle/production.config"),
            b"awaiting Access",
        )
        .unwrap();
        private_write(&live, b"reconciled Access").unwrap();
        let chosen = promotion_config(&live, &pending, &first_dir, "production", &first, &first);
        assert_eq!(fs::read(chosen).unwrap(), b"reconciled Access");
        crate::workstation::select_generation(&root, &first).unwrap();
        private_write(&pending, b"authorized update").unwrap();
        let chosen = promotion_config(&live, &pending, &second_dir, "production", &first, &second);
        switch_host(&root, &live, Some(&second), &fs::read(chosen).unwrap()).unwrap();
        assert_eq!(fs::read(&live).unwrap(), b"authorized update");
        assert_eq!(
            root.join(".fv-current").canonicalize().unwrap(),
            second_dir.canonicalize().unwrap()
        );
        assert!(switch_host(&root, &live, Some(&"d".repeat(40)), b"missing restore").is_err());
        assert_eq!(fs::read(&live).unwrap(), b"authorized update");
        switch_host(&root, &live, Some(&first), b"reconciled Access").unwrap();
        assert_eq!(
            root.join(".fv-current").canonicalize().unwrap(),
            first_dir.canonicalize().unwrap()
        );
        assert_eq!(fs::read(&live).unwrap(), b"reconciled Access");
        fs::remove_dir_all(root).unwrap();
    }
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
