use anyhow::{Result, ensure};
use fv_config::{Config, private_write, random_secret};
use serde_json::json;
use std::{collections::BTreeMap, fs, path::Path};

pub fn init(root: &Path, c: &Config) -> Result<()> {
    let file = root.join(format!(".state/{}.env", c.environment));
    if file.exists() {
        return render(root, c);
    }
    let dir = root.join(format!(".state/{}", c.environment));
    fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.join(".state"), fs::Permissions::from_mode(0o700))?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    let mut e = BTreeMap::new();
    for key in [
        "POSTGRES_PASSWORD",
        "MIGRATOR_PASSWORD",
        "CONTROL_MIGRATOR_PASSWORD",
        "API_PASSWORD",
        "WORKER_PASSWORD",
        "ADMIN_PASSWORD",
        "RUNNER_PASSWORD",
        "HASURA_PASSWORD",
        "HASURA_ADMIN_SECRET",
        "HASURA_JWT_SECRET",
        "LOCAL_JWT_SECRET",
        "BACKUP_CIPHER_PASS",
        "BACKUP_HMAC_KEY",
        "AMQP_PASSWORD",
    ] {
        e.insert(key.to_owned(), random_secret());
    }
    e.insert("FV_ENV".into(), c.environment.clone());
    e.insert("COMPOSE_PROJECT_NAME".into(), c.project.clone());
    e.insert("FV_STATE_DIR".into(), format!(".state/{}", c.environment));
    let connections = [
        ("DATABASE_URL", "fv_api", "API_PASSWORD", "fv_app"),
        (
            "WORKER_DATABASE_URL",
            "fv_worker",
            "WORKER_PASSWORD",
            "fv_app",
        ),
        (
            "MIGRATION_DATABASE_URL",
            "fv_migrator",
            "MIGRATOR_PASSWORD",
            "fv_app",
        ),
        (
            "CONTROL_DATABASE_URL",
            "fv_admin",
            "ADMIN_PASSWORD",
            "fv_control",
        ),
        (
            "CONTROL_MIGRATION_DATABASE_URL",
            "fv_control_migrator",
            "CONTROL_MIGRATOR_PASSWORD",
            "fv_control",
        ),
        (
            "RUNNER_DATABASE_URL",
            "fv_runner",
            "RUNNER_PASSWORD",
            "fv_control",
        ),
        (
            "HASURA_DATABASE_URL",
            "fv_hasura",
            "HASURA_PASSWORD",
            "fv_app",
        ),
    ];
    for (key, user, pw, db) in connections {
        e.insert(
            key.into(),
            format!("postgresql://{user}:{}@127.0.0.1:43832/{db}", e[pw]),
        );
    }
    e.insert(
        "AMQP_URL".into(),
        format!("amqp://fv:{}@127.0.0.1:43872/fv", e["AMQP_PASSWORD"]),
    );
    for (key, value) in [
        (
            "ADMIN_ORIGIN",
            if c.environment == "local" {
                "http://127.0.0.1:43802".into()
            } else {
                format!("https://{}", c.admin_domain)
            },
        ),
        ("HASURA_URL", "http://127.0.0.1:43803".into()),
        ("OIDC_ISSUER", c.auth.issuer.clone()),
        ("OIDC_AUDIENCE", c.auth.audience.clone()),
        ("OIDC_JWKS_URL", c.auth.jwks_url.clone()),
        ("OIDC_CLIENT_ID", c.auth.client_id.clone()),
        (
            "OIDC_AUTHORIZATION_ENDPOINT",
            c.auth.authorization_endpoint.clone(),
        ),
        ("OIDC_TOKEN_ENDPOINT", c.auth.token_endpoint.clone()),
        ("OIDC_MFA_ACR", "urn:mfa".into()),
        ("ACCESS_TEAM", c.cloudflare.access_team.clone()),
        ("ACCESS_AUD", c.cloudflare.access_aud.clone()),
        ("CF_BINARY", c.cloudflare.cf_binary.clone()),
        ("CF_SHA256", c.cloudflare.cf_sha256.clone()),
        ("CF_ACCOUNT_ID", c.cloudflare.account_id.clone()),
        ("CF_ZONE_ID", c.cloudflare.zone_id.clone()),
        ("CF_ZONE_NAME", c.cloudflare.zone_name.clone()),
        ("CF_MANAGED_NAMES", c.cloudflare.managed_names.join(",")),
        (
            "CF_TUNNEL_NAMES",
            c.tunnel_domains().collect::<Vec<_>>().join(","),
        ),
    ] {
        e.insert(key.into(), value);
    }
    for key in [
        "CF_READ_TOKEN",
        "CF_WRITE_TOKEN",
        "CLOUDFLARE_TUNNEL_TOKEN",
        "BACKUP_S3_KEY",
        "BACKUP_S3_SECRET",
        "OBJECT_ACCESS_KEY",
        "OBJECT_SECRET_KEY",
    ] {
        if let Ok(value) = std::env::var(key) {
            ensure!(!value.contains(['\n', '\r']), "invalid secret");
            e.insert(key.into(), value);
        }
    }
    private_write(
        &file,
        e.iter()
            .map(|(k, v)| format!("{k}={v}\n"))
            .collect::<String>()
            .as_bytes(),
    )?;
    render(root, c)
}
pub fn render(root: &Path, c: &Config) -> Result<()> {
    let mut e = super::env(root, c)?;
    if c.environment == "local" {
        e.insert("ADMIN_ORIGIN".into(), format!("https://{}", c.admin_domain));
        e.insert("API_ORIGIN".into(), format!("https://{}", c.api_domain));
        e.insert("OIDC_ISSUER".into(), c.auth.issuer.clone());
        e.insert("OIDC_AUDIENCE".into(), c.auth.audience.clone());
    }
    let external = root.join(format!("secrets/{}.env", c.environment));
    if external.exists() {
        let meta = external.symlink_metadata()?;
        ensure!(meta.is_file(), "secret catalog must be a regular file");
        #[cfg(unix)]
        if c.environment != "local" {
            use std::os::unix::fs::PermissionsExt;
            ensure!(
                meta.permissions().mode() & 0o077 == 0,
                "remote secret catalog must be private"
            );
        }
        for (key, value) in fv_config::env_read(&external)? {
            ensure!(
                key == "OIDC_MFA_ACR"
                    || [
                        "CF_",
                        "CLOUDFLARE_",
                        "BACKUP_S3_",
                        "IMMUTABLE_",
                        "AUDIT_",
                        "OBJECT_",
                        "ALERT_",
                        "ACCESS_ADMIN_",
                        "AGE_",
                        "MEMBERS_",
                    ]
                    .iter()
                    .any(|prefix| key.starts_with(prefix)),
                "unknown external secret key"
            );
            ensure!(!value.contains(['\n', '\r']), "invalid external secret");
            e.insert(key, value);
        }
    }
    // A catalog can supply credentials; the validated manifest owns routing,
    // identity settings and the scope of provider access.
    for (key, value) in [
        ("CF_BINARY", c.cloudflare.cf_binary.clone()),
        ("CF_SHA256", c.cloudflare.cf_sha256.clone()),
        ("CF_ACCOUNT_ID", c.cloudflare.account_id.clone()),
        ("CF_ZONE_ID", c.cloudflare.zone_id.clone()),
        ("CF_ZONE_NAME", c.cloudflare.zone_name.clone()),
        ("CF_MANAGED_NAMES", c.cloudflare.managed_names.join(",")),
        ("ACCESS_TEAM", c.cloudflare.access_team.clone()),
        ("ACCESS_AUD", c.cloudflare.access_aud.clone()),
        ("OIDC_ISSUER", c.auth.issuer.clone()),
        ("OIDC_AUDIENCE", c.auth.audience.clone()),
        ("OIDC_JWKS_URL", c.auth.jwks_url.clone()),
        ("OIDC_CLIENT_ID", c.auth.client_id.clone()),
        (
            "OIDC_AUTHORIZATION_ENDPOINT",
            c.auth.authorization_endpoint.clone(),
        ),
        ("OIDC_TOKEN_ENDPOINT", c.auth.token_endpoint.clone()),
        ("ADMIN_ORIGIN", format!("https://{}", c.admin_domain)),
        ("API_ORIGIN", format!("https://{}", c.api_domain)),
    ] {
        // Local operator overrides for cf are used by the isolated test and
        // domain tooling. The remote manifest owns every provider setting.
        if c.environment != "local" || matches!(key, "CF_ZONE_NAME" | "CF_MANAGED_NAMES") {
            e.insert(key.into(), value);
        }
    }
    let dir = root.join(format!(".state/{}", c.environment));
    let images = super::validate_images(root)?;
    for name in [
        "POSTGRES_PASSWORD",
        "MIGRATOR_PASSWORD",
        "CONTROL_MIGRATOR_PASSWORD",
        "API_PASSWORD",
        "WORKER_PASSWORD",
        "ADMIN_PASSWORD",
        "RUNNER_PASSWORD",
        "HASURA_PASSWORD",
    ] {
        ensure!(
            e[name].len() == 64 && e[name].bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid generated credential"
        );
    }
    let apps = fv_config::applications(root)?;
    let mut sql = String::new();
    for (role, pw) in [
        ("fv_control_migrator", "CONTROL_MIGRATOR_PASSWORD"),
        ("fv_admin", "ADMIN_PASSWORD"),
        ("fv_runner", "RUNNER_PASSWORD"),
        ("fv_control_monitor", "CONTROL_MONITOR_PASSWORD"),
        ("fv_hasura_metadata", "HASURA_METADATA_PASSWORD"),
    ] {
        let password = e.entry(pw.into()).or_insert_with(random_secret).clone();
        sql.push_str(&format!("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{role}') THEN CREATE ROLE {role} LOGIN PASSWORD '{password}'; END IF; END $$;\n"));
    }
    for role in ["fv_api", "fv_worker", "fv_hasura", "fv_monitor"] {
        sql.push_str(&format!("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{role}') THEN CREATE ROLE {role} NOLOGIN; END IF; END $$; ALTER ROLE {role} NOLOGIN;\n"));
    }
    sql.push_str("GRANT fv_hasura TO fv_hasura_metadata;\n");
    for (db, owner) in [
        ("fv_control", "fv_control_migrator"),
        ("fv_hasura", "fv_hasura_metadata"),
    ] {
        sql.push_str(&format!("SELECT 'CREATE DATABASE {db} OWNER {owner}' WHERE NOT EXISTS(SELECT FROM pg_database WHERE datname='{db}')\\gexec\n"));
    }
    for a in &apps {
        let prefix = a.id.replace('-', "_").to_uppercase();
        let role_prefix = format!("fv_{}", a.id.replace('-', "_"));
        for (kind, group) in [
            ("api", Some("fv_api")),
            ("worker", Some("fv_worker")),
            ("hasura", Some("fv_hasura")),
            ("migrator", None),
            ("monitor", Some("fv_monitor")),
        ] {
            let key = format!("{prefix}_{}_PASSWORD", kind.to_uppercase());
            let password = e.entry(key).or_insert_with(random_secret).clone();
            ensure!(
                password.len() == 64 && password.bytes().all(|b| b.is_ascii_hexdigit()),
                "invalid namespace credential"
            );
            let role = format!("{role_prefix}_{kind}");
            sql.push_str(&format!("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{role}') THEN CREATE ROLE {role} LOGIN PASSWORD '{password}'; END IF; END $$;\n"));
            if kind == "hasura" {
                sql.push_str(&format!("ALTER ROLE {role} SET statement_timeout='10s';\n"));
            }
            if let Some(group) = group {
                sql.push_str(&format!("GRANT {group} TO {role};\n"));
            }
            let env_key = match kind {
                "api" => format!("{prefix}_DATABASE_URL"),
                "migrator" => format!("MIGRATION_{prefix}_DATABASE_URL"),
                "worker" => format!("WORKER_{prefix}_DATABASE_URL"),
                "hasura" => format!("HASURA_{prefix}_DATABASE_URL"),
                _ => format!("MONITOR_{prefix}_DATABASE_URL"),
            };
            e.insert(
                env_key,
                format!(
                    "postgresql://{role}:{password}@127.0.0.1:43832/{}",
                    a.database
                ),
            );
        }
        let database = &a.database;
        sql.push_str(&format!("SELECT 'CREATE DATABASE \"{database}\" OWNER {role_prefix}_migrator' WHERE NOT EXISTS(SELECT FROM pg_database WHERE datname='{database}')\\gexec\nREVOKE CONNECT ON DATABASE \"{database}\" FROM PUBLIC;\nGRANT CONNECT ON DATABASE \"{database}\" TO {role_prefix}_api,{role_prefix}_worker,{role_prefix}_hasura,{role_prefix}_migrator,{role_prefix}_monitor;\n\\connect \"{database}\"\nCREATE EXTENSION IF NOT EXISTS vector;\nCREATE EXTENSION IF NOT EXISTS pgcrypto;\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\n"));
    }
    sql.push_str("\\connect fv_control\nCREATE EXTENSION IF NOT EXISTS pgcrypto;\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\nREVOKE CONNECT ON DATABASE fv_control FROM PUBLIC;\nGRANT CONNECT ON DATABASE fv_control TO fv_admin,fv_runner,fv_control_migrator,fv_control_monitor;\n");
    e.insert(
        "MONITOR_CONTROL_DATABASE_URL".into(),
        format!(
            "postgresql://fv_control_monitor:{}@127.0.0.1:43832/fv_control",
            e["CONTROL_MONITOR_PASSWORD"]
        ),
    );
    e.entry("MONITOR_TOKEN".into())
        .or_insert_with(random_secret);
    e.insert(
        "DATABASE_URL".into(),
        e["FOUNDER_VILLAGE_DATABASE_URL"].clone(),
    );
    e.insert(
        "WORKER_DATABASE_URL".into(),
        e["WORKER_FOUNDER_VILLAGE_DATABASE_URL"].clone(),
    );
    e.insert(
        "MIGRATION_DATABASE_URL".into(),
        e["MIGRATION_FOUNDER_VILLAGE_DATABASE_URL"].clone(),
    );
    private_write(&dir.join("postgres/init.sql"), sql.as_bytes())?;
    let mut pgbackrest = format!(
        "[global]\nrepo1-type={}\nrepo1-path={}\nrepo1-cipher-type=aes-256-cbc\nrepo1-cipher-pass={}\nrepo1-retention-full-type=time\nrepo1-retention-full={}\nlog-level-console=warn\nstart-fast=y\nprocess-max=2\n[main]\npg1-path=/var/lib/postgresql/data\npg1-socket-path=/var/run/postgresql\n",
        if c.environment == "local" {
            "posix"
        } else {
            "s3"
        },
        if c.environment == "local" {
            "/var/lib/pgbackrest"
        } else {
            "/founder-village"
        },
        e["BACKUP_CIPHER_PASS"],
        c.backup.retention_days
    );
    if c.environment != "local" {
        ensure!(
            e.contains_key("BACKUP_S3_KEY") && e.contains_key("BACKUP_S3_SECRET"),
            "backup credentials required"
        );
        pgbackrest.push_str(&format!("\n[global]\nrepo1-s3-endpoint={}\nrepo1-s3-bucket={}\nrepo1-s3-region={}\nrepo1-s3-key={}\nrepo1-s3-key-secret={}\nrepo1-s3-uri-style=path\n",c.backup.s3_endpoint.trim_start_matches("https://"),c.backup.bucket,c.backup.region,e["BACKUP_S3_KEY"],e["BACKUP_S3_SECRET"]));
    }
    if let Some((before, extra)) = pgbackrest.split_once("\n[global]\nrepo1-s3-endpoint=") {
        let extra = format!("repo1-s3-endpoint={extra}");
        pgbackrest = before.replace("[main]", &format!("{extra}\n[main]"));
    }
    private_write(&dir.join("postgres/pgbackrest.conf"), pgbackrest.as_bytes())?;
    let mut api_env = serde_json::Map::new();
    for (key, value) in &e {
        if key.starts_with("OBJECT_") || key.starts_with("OTEL_") || key.starts_with("MEMBERS_") {
            api_env.insert(key.clone(), json!(value));
        }
    }
    let mut worker_env = serde_json::Map::new();
    let mut hasura_env = serde_json::Map::new();
    for a in &apps {
        let key = a.id.replace('-', "_").to_uppercase();
        for (prefix, map) in [
            ("", &mut api_env),
            ("WORKER_", &mut worker_env),
            ("HASURA_", &mut hasura_env),
        ] {
            let name = format!("{prefix}{key}_DATABASE_URL");
            map.insert(
                name.clone(),
                json!(e[&name].replace("127.0.0.1:43832", "postgres:5432")),
            );
        }
    }
    let mut overlay = json!({"services":{"api-blue":{"environment":api_env},"api-green":{"environment":api_env},"workers":{"environment":worker_env},"hasura":{"environment":hasura_env}}});
    if c.cloudflare.ssh_domain.is_some() {
        overlay["services"]["cloudflared"] = json!({
            "networks": ["edge", "tunnel-ssh"],
            "extra_hosts": {"fv-operator":fv_config::TUNNEL_SSH_GATEWAY}
        });
        overlay["networks"] = json!({"tunnel-ssh": {
            "driver":"bridge", "internal":true,
            "driver_opts":{"com.docker.network.bridge.name":fv_config::TUNNEL_SSH_INTERFACE},
            "ipam":{"config":[{"subnet":fv_config::TUNNEL_SSH_SUBNET,"gateway":fv_config::TUNNEL_SSH_GATEWAY}]}
        }});
    }
    private_write(
        &dir.join("applications.compose.json"),
        &serde_json::to_vec(&overlay)?,
    )?;
    let jwt = json!({"type":"HS256","key":e["HASURA_JWT_SECRET"],"issuer":"fv-api","audience":"fv-hasura"});
    if let Some(token) = e.get("CLOUDFLARE_TUNNEL_TOKEN") {
        private_write(&dir.join("tunnel/token"), token.as_bytes())?;
    }
    e.insert(
        "ROOT_ADMIN_ACTORS".into(),
        serde_json::to_string(&c.auth.root_actors)?,
    );
    e.insert("BACKUP_S3_ENDPOINT".into(), c.backup.s3_endpoint.clone());
    e.insert("BACKUP_S3_BUCKET".into(), c.backup.bucket.clone());
    e.insert("BACKUP_S3_REGION".into(), c.backup.region.clone());
    let mut generated = e.clone();
    generated.insert("HASURA_JWT_CONFIG".into(), jwt.to_string());
    for (key, val) in images {
        generated.insert(format!("{}_IMAGE", key.to_uppercase()), val);
    }
    for value in generated.values() {
        fv_config::validate_owned_url(value, &c.cloudflare.zone_name)?;
    }
    private_write(
        &root.join(format!(".state/{}.env", c.environment)),
        generated
            .iter()
            .map(|(k, v)| format!("{k}={v}\n"))
            .collect::<String>()
            .as_bytes(),
    )?;
    let definitions = json!({"users":[{"name":"fv","password":e["AMQP_PASSWORD"],"tags":[]}],"vhosts":[{"name":"fv"}],"permissions":[{"user":"fv","vhost":"fv","configure":"^fv\\..*","write":"^(fv\\..*|amq.default)$","read":"^fv\\..*"}]});
    private_write(
        &dir.join("rabbitmq/definitions.json"),
        serde_json::to_vec(&definitions)?.as_slice(),
    )?;
    let active = dir.join("active-color");
    if !active.exists() {
        private_write(&active, b"blue")?;
    }
    let color = fs::read_to_string(&active)?;
    ensure!(
        ["blue", "green"].contains(&color.trim()),
        "invalid active color"
    );
    let caddy = format!(
        "{{\n admin 127.0.0.1:2019\n auto_https off\n}}\n:8080 {{\n @api host {}\n handle @api {{\n  reverse_proxy api-{}:8080\n }}\n @admin host {}\n handle @admin {{\n  reverse_proxy admin:8080\n }}\n respond 404\n}}\n",
        c.api_domain,
        color.trim(),
        c.admin_domain
    );
    private_write(&dir.join("caddy/Caddyfile"), caddy.as_bytes())?;
    private_write(&dir.join("runtime.json"), &serde_json::to_vec_pretty(c)?)?;
    // The admin container receives only the fields displayed by its domain view.
    let admin_routes = dir.join("admin/runtime.json");
    private_write(
        &admin_routes,
        &serde_json::to_vec(&json!({
            "environment":c.environment, "api_domain":c.api_domain, "admin_domain":c.admin_domain,
            "cloudflare":{"zone_name":c.cloudflare.zone_name,"managed_names":c.cloudflare.managed_names}
        }))?,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir.join("admin"), fs::Permissions::from_mode(0o755))?;
        fs::set_permissions(admin_routes, fs::Permissions::from_mode(0o644))?;
    }
    Ok(())
}
