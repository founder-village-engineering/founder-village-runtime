use anyhow::{Context, Result, ensure};
use fv_config::{Config, digest, private_write};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{collections::BTreeMap, fs, path::Path};

/// The workstation stores this encrypted verifier independently of the mirrored
/// recovery bundle. Existing backups retain their original signing key.
pub fn escrow_verifier(root: &Path, c: &Config) -> Result<()> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    ensure!(c.environment == "production", "production escrow required");
    let env = super::env(root, c)?;
    let recipient = env
        .get("AGE_RECIPIENT")
        .context("recovery recipient missing")?;
    let key = env
        .get("BACKUP_HMAC_KEY")
        .context("backup verifier missing")?;
    ensure!(
        recipient.starts_with("age1")
            && recipient.bytes().all(|b| b.is_ascii_alphanumeric())
            && key.len() == 64
            && key.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid recovery settings"
    );
    let mut age = Command::new("/usr/bin/age")
        .args(["--armor", "-r", recipient])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    age.stdin
        .take()
        .context("age input unavailable")?
        .write_all(key.as_bytes())?;
    let encrypted = age.wait_with_output()?;
    ensure!(encrypted.status.success(), "backup verifier escrow failed");
    println!(
        "{}",
        json!({"fingerprint": digest(key.as_bytes()), "encrypted": std::str::from_utf8(&encrypted.stdout)?})
    );
    Ok(())
}
fn info(root: &Path, c: &Config) -> Result<Value> {
    let env_file = format!(".state/{}.env", c.environment);
    let output = fv_host::docker(root)
        .current_dir(root)
        .args([
            "compose",
            "--project-directory",
            root.to_str().unwrap(),
            "--env-file",
            &env_file,
            "-p",
            &c.project,
            "-f",
            "infra/compose/compose.yml",
            "exec",
            "-T",
            "-u",
            "postgres",
            "postgres",
            "pgbackrest",
            "--stanza=main",
            "--output=json",
            "info",
        ])
        .output()?;
    ensure!(output.status.success(), "backup inventory unavailable");
    ensure!(output.stdout.len() < 4 * 1024 * 1024, "inventory too large");
    Ok(serde_json::from_slice(&output.stdout)?)
}
pub fn capture(root: &Path, c: &Config, kind: &str) -> Result<()> {
    ensure!(["full", "diff"].contains(&kind), "invalid backup type");
    super::compose(
        root,
        c,
        &[
            "exec",
            "-T",
            "-u",
            "postgres",
            "postgres",
            "pgbackrest",
            "--stanza=main",
            "stanza-create",
        ],
    )?;
    super::compose(
        root,
        c,
        &[
            "exec",
            "-T",
            "-u",
            "postgres",
            "postgres",
            "pgbackrest",
            "--stanza=main",
            "check",
        ],
    )?;
    super::compose(
        root,
        c,
        &[
            "exec",
            "-T",
            "-u",
            "postgres",
            "postgres",
            "pgbackrest",
            "--stanza=main",
            &format!("--type={kind}"),
            "backup",
        ],
    )?;
    let inventory = info(root, c)?;
    let database_list = fv_host::docker(root)
        .args([
            "exec",
            &format!("{}-postgres-1", c.project),
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-At",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            "SELECT json_build_object('databases',(SELECT json_agg(datname ORDER BY datname) FROM pg_database WHERE NOT datistemplate),'settings',(SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN ('max_connections','max_worker_processes','max_wal_senders','max_prepared_transactions','max_locks_per_transaction','track_commit_timestamp')))",
        ])
        .output()?;
    ensure!(database_list.status.success(), "database inventory failed");
    let details: Value = serde_json::from_slice(&database_list.stdout)?;
    let database_names: Vec<String> = serde_json::from_value(details["databases"].clone())?;
    for application in fv_config::applications(root)? {
        ensure!(
            database_names.contains(&application.database),
            "application missing from database inventory"
        );
    }

    let body = serde_json::to_vec(
        &json!({"environment":c.environment,"config_hash":digest(&serde_json::to_vec(c)?),"offsite":c.environment!="local","applications":fv_config::applications(root)?,"databases":database_names,"postgres_settings":details["settings"],"inventory":inventory}),
    )?;
    let e = super::env(root, c)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(e["BACKUP_HMAC_KEY"].as_bytes())?;
    mac.update(&body);
    let signature = format!("{:x}", mac.finalize().into_bytes());
    let envelope = json!({"body":String::from_utf8(body.clone())?,"signature":signature});
    private_write(
        &root.join(format!(".state/{}/backup-receipt.json", c.environment)),
        &serde_json::to_vec(&envelope)?,
    )?;
    let fingerprint = verify_inventory(root, c)?;
    if c.environment != "local" {
        let env = super::env(root, c)?;
        fv_host::run(
            "node",
            &[
                "--import",
                "tsx",
                "scripts/recovery-bundle.ts",
                &fingerprint,
            ],
            root,
            &env,
            120,
        )?;
        fv_host::run(
            "node",
            &[
                "--import",
                "tsx",
                "scripts/replicate-backups.ts",
                &fingerprint,
            ],
            root,
            &env,
            7200,
        )?;
        private_write(
            &root.join(format!(".state/{}/immutable-backup", c.environment)),
            fingerprint.as_bytes(),
        )?;
    }
    let mut db = super::client(root, c)?;
    db.execute("INSERT INTO control.backups(id,manifest_hash,offsite,verified) VALUES(gen_random_uuid(),$1,$2,true)",&[&digest(&body),&(c.environment!="local")])?;
    super::record(root, c, "backup.capture", "succeeded")?;
    Ok(())
}
pub fn verify(root: &Path, c: &Config) -> Result<()> {
    let fingerprint = verify_inventory(root, c)?;
    if c.environment != "local" {
        let mirrored =
            fs::read_to_string(root.join(format!(".state/{}/immutable-backup", c.environment)))
                .context("no verified immutable backup copy")?;
        ensure!(
            mirrored == fingerprint,
            "immutable copy does not cover the current backup receipt"
        );
    }
    Ok(())
}

fn verify_inventory(root: &Path, c: &Config) -> Result<String> {
    let bytes = fs::read(root.join(format!(".state/{}/backup-receipt.json", c.environment)))?;
    let receipt: Value = serde_json::from_slice(&bytes)?;
    let body = receipt["body"].as_str().context("missing body")?;
    let e = super::env(root, c)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(e["BACKUP_HMAC_KEY"].as_bytes())?;
    mac.update(body.as_bytes());
    let expected = format!("{:x}", mac.finalize().into_bytes());
    use subtle::ConstantTimeEq;
    ensure!(
        bool::from(
            expected
                .as_bytes()
                .ct_eq(receipt["signature"].as_str().unwrap_or("").as_bytes())
        ),
        "backup receipt signature invalid"
    );
    let payload: Value = serde_json::from_str(body)?;
    ensure!(
        payload["environment"] == c.environment,
        "backup environment mismatch"
    );
    let current = info(root, c)?;
    let backups = current[0]["backup"]
        .as_array()
        .context("no usable backup inventory")?;
    let newest = backups.last().context("no complete backups")?;
    let stamp = newest["timestamp"]["stop"]
        .as_u64()
        .context("missing completion time")?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    ensure!(
        stamp <= now + 60 && now.saturating_sub(stamp) < 86400,
        "backup stale"
    );
    ensure!(
        current[0]["status"]["code"] == 0,
        "backup repository unhealthy"
    );
    ensure!(
        payload["inventory"][0]["backup"]
            .as_array()
            .is_some_and(|old| old.iter().any(|b| b["label"] == newest["label"])),
        "backup receipt does not cover current backup"
    );
    Ok(digest(body.as_bytes()))
}
pub fn restore_drill(root: &Path, c: &Config) -> Result<()> {
    verify(root, c)?;
    let started = std::time::Instant::now();
    let receipt: Value = serde_json::from_slice(&fs::read(
        root.join(format!(".state/{}/backup-receipt.json", c.environment)),
    )?)?;
    let payload: Value = serde_json::from_str(
        receipt["body"]
            .as_str()
            .context("missing authenticated backup body")?,
    )?;
    let mut recovery_options = String::new();
    for (name, value) in payload["postgres_settings"]
        .as_object()
        .context("backup missing recovery settings; capture a new snapshot")?
    {
        ensure!(
            [
                "max_connections",
                "max_worker_processes",
                "max_wal_senders",
                "max_prepared_transactions",
                "max_locks_per_transaction",
                "track_commit_timestamp"
            ]
            .contains(&name.as_str()),
            "unknown recovery parameter"
        );
        let value = value.as_str().context("invalid recovery parameter")?;
        ensure!(
            !value.is_empty()
                && ((value.bytes().all(|b| b.is_ascii_digit()) && value.parse::<u32>()? <= 10000)
                    || (name == "track_commit_timestamp" && ["on", "off"].contains(&value))),
            "unsafe recovery parameter"
        );
        recovery_options.push_str(&format!(" -c {name}={value}"));
    }
    let marker = format!("fv-drill-{}", &fv_config::random_secret()[..12]);
    let source = format!("{}-postgres-1", c.project);
    let sql = format!("SELECT pg_create_restore_point('{marker}'); SELECT pg_switch_wal();");
    let point = fv_host::docker(root)
        .args([
            "exec",
            &source,
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-At",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            &sql,
        ])
        .output()?;
    ensure!(point.status.success(), "recovery marker creation failed");
    let lsn = String::from_utf8(point.stdout)?
        .lines()
        .next()
        .context("missing restore LSN")?
        .to_string();
    ensure!(
        lsn.bytes().all(|b| b.is_ascii_hexdigit() || b == b'/'),
        "invalid restore LSN"
    );
    super::compose(
        root,
        c,
        &[
            "exec",
            "-T",
            "-u",
            "postgres",
            "postgres",
            "pgbackrest",
            "--stanza=main",
            "check",
        ],
    )?;
    ensure!(
        started.elapsed().as_secs() <= c.backup.rpo_seconds as u64,
        "WAL archive exceeded recovery point objective"
    );

    let name = format!(
        "{}-restore-{}",
        c.project,
        &fv_config::random_secret()[..12]
    );
    let state = root.join(format!(".state/{}", c.environment));
    let image = if c.environment == "local" {
        format!("fv-postgres:{}", c.environment)
    } else {
        let installed = super::workstation::Manifest::installed(root, c.provider.architecture)?;
        installed.load_images(root)?;
        installed.images["postgres"].tag.clone()
    };
    let mount = format!(
        "type=bind,source={},target=/run/fv/config,readonly",
        state.join("postgres/pgbackrest.conf").display()
    );
    let backup_mount = format!(
        "source={}_backups,target=/var/lib/pgbackrest,readonly",
        c.project
    );
    // Parameter names are allowlisted, and values are numeric or on/off, before shell rendering.
    let script = format!(
        "cp /run/fv/config /tmp/pgbackrest.conf; chown postgres:postgres /tmp/pgbackrest.conf; chmod 600 /tmp/pgbackrest.conf; gosu postgres pgbackrest --config=/tmp/pgbackrest.conf --stanza=main --pg1-path=/tmp/restored --type=name --target={marker} --target-action=promote restore; exec gosu postgres postgres -D /tmp/restored -c listen_addresses='' -c archive_mode=off -c unix_socket_directories=/tmp {recovery_options}"
    );
    let network = if c.environment == "local" {
        "none"
    } else {
        "bridge"
    };
    fv_host::run(
        "docker",
        &[
            "run",
            "--pull",
            "never",
            "-d",
            "--name",
            &name,
            "--network",
            network,
            "--mount",
            &backup_mount,
            "--mount",
            &mount,
            "--entrypoint",
            "bash",
            &image,
            "-ceu",
            &script,
        ],
        root,
        &BTreeMap::new(),
        30,
    )?;
    let result = (|| -> Result<()> {
        let mut ready = false;
        for _ in 0..180 {
            let check = fv_host::docker(root)
                .args(["exec", &name, "pg_isready", "-h", "/tmp", "-U", "postgres"])
                .output()?;
            if check.status.success() {
                ready = true;
                break;
            }
            let state = fv_host::docker(root)
                .args(["inspect", "--format", "{{.State.Running}}", &name])
                .output()?;
            ensure!(
                String::from_utf8_lossy(&state.stdout).trim() == "true",
                "isolated restore stopped; inspect restore diagnostics"
            );
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        ensure!(ready, "isolated restore did not become ready");
        let consistency =
            format!("SELECT NOT pg_is_in_recovery() AND pg_last_wal_replay_lsn()>='{lsn}'::pg_lsn");
        let checked = fv_host::docker(root)
            .args([
                "exec",
                "-u",
                "postgres",
                &name,
                "psql",
                "-h",
                "/tmp",
                "-U",
                "postgres",
                "-d",
                "postgres",
                "-At",
                "-c",
                &consistency,
            ])
            .output()?;
        ensure!(
            checked.status.success() && String::from_utf8_lossy(&checked.stdout).trim() == "t",
            "PITR marker not reached"
        );

        let mut targets=fv_config::applications(root)?.into_iter().map(|a|(a.database,"SELECT extversion FROM pg_extension WHERE extname='vector'; SELECT count(*) FROM public.fv_migrations; SELECT count(*) FROM app.records;".to_string())).collect::<Vec<_>>();
        targets.push((
            "fv_control".into(),
            "SELECT count(*) FROM public.fv_migrations; SELECT count(*) FROM control.audit;".into(),
        ));
        for (database, query) in &targets {
            let out = fv_host::docker(root)
                .args([
                    "exec",
                    "-u",
                    "postgres",
                    &name,
                    "psql",
                    "-h",
                    "/tmp",
                    "-U",
                    "postgres",
                    "-d",
                    database,
                    "-At",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-c",
                    query,
                ])
                .output()?;
            ensure!(
                out.status.success() && !out.stdout.is_empty(),
                "restored schema/data validation failed"
            );
        }
        ensure!(
            started.elapsed().as_secs() <= c.backup.rto_seconds as u64,
            "recovery time target exceeded"
        );
        let mut db = super::client(root, c)?;
        db.execute("UPDATE control.backups SET restored=true WHERE id=(SELECT id FROM control.backups ORDER BY created_at DESC LIMIT 1)",&[])?;
        private_write(
            &state.join("restore-receipt.json"),
            &serde_json::to_vec(
                &json!({"environment":c.environment,"target":name,"seconds":started.elapsed().as_secs(),"isolated":true,"pitr_marker":marker,"pitr_lsn":lsn,"checks":["named-point-in-time-recovery","postgres-start","vector-extension","app-migrations","control-migrations","data-queries"],"clean_host":false}),
            )?,
        )?;
        super::record(root, c, "backup.restore-drill", "succeeded")?;
        Ok(())
    })();
    if result.is_err()
        && let Ok(logs) = fv_host::docker(root).args(["logs", &name]).output()
    {
        let mut bytes = logs.stdout;
        bytes.extend(logs.stderr);
        let _ = private_write(&state.join("restore-failure.log"), &bytes);
    }
    let cleanup = fv_host::run("docker", &["rm", "-f", &name], root, &BTreeMap::new(), 30);
    result?;
    cleanup?;
    Ok(())
}
