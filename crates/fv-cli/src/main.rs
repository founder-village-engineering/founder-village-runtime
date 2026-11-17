use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use fv_config::private_write;
use std::{collections::BTreeMap, fs, path::PathBuf};
#[derive(Parser)]
#[command(version, about = "Founder Village runtime control")]
struct Args {
    #[arg(long, default_value = ".")]
    root: PathBuf,
    #[arg(long, default_value = "config/local.json")]
    config: PathBuf,
    #[command(subcommand)]
    command: Cmd,
}
#[derive(Subcommand)]
enum Cmd {
    Init,
    Validate,
    Render,
    Up,
    Down,
    Doctor,
    BrokerUpgrade,
    QueueUpgrade,
    Provision {
        #[arg(value_parser=["plan","apply","status"])]
        action: String,
        #[arg(long)]
        public_key: Option<PathBuf>,
    },
    Host {
        #[arg(value_parser=["plan","apply"])]
        action: String,
    },
    Release {
        #[arg(value_parser=["prepare","deploy","rollback","verify"])]
        action: String,
        #[arg(long)]
        revision: Option<String>,
        #[arg(long)]
        image: Option<String>,
        #[arg(long)]
        id: Option<String>,
    },
    Backup {
        #[arg(value_parser=["capture","verify","restore-drill"])]
        action: String,
        #[arg(long, default_value = "full")]
        kind: String,
    },
    Wireguard {
        #[arg(value_parser=["enroll","revoke","status","apply"])]
        action: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        public_key: Option<String>,
        #[arg(long)]
        address: Option<String>,
        #[arg(long)]
        expires: Option<String>,
    },
    Ops {
        #[arg(long)]
        once: bool,
    },
    AdminGrant {
        #[arg(long)]
        actor: String,
        #[arg(long, value_delimiter = ',')]
        actions: Vec<String>,
        #[arg(long, value_delimiter = ',')]
        applications: Vec<String>,
    },
}
fn main() {
    if let Err(e) = execute() {
        eprintln!("fv: {e}");
        std::process::exit(1)
    }
}
fn execute() -> Result<()> {
    let a = Args::parse();
    let root = a.root.canonicalize()?;
    let c = fv_config::load(&root.join(&a.config))?;
    if matches!(a.command, Cmd::Validate) {
        fv_ops::validate_images(&root)?;
        println!("configuration valid");
        return Ok(());
    }
    let _lock = if matches!(a.command, Cmd::Ops { .. }) {
        None
    } else {
        Some(fv_ops::lock(&root, &c)?)
    };
    match a.command {
        Cmd::Validate => {}
        Cmd::Init => {
            fv_ops::render::init(&root, &c)?;
            println!("private runtime configuration initialized");
        }
        Cmd::Render => {
            fv_ops::render::render(&root, &c)?;
            println!("runtime configuration rendered");
        }
        Cmd::Up => {
            fv_ops::render::init(&root, &c)?;
            fv_ops::compose(
                &root,
                &c,
                &["up", "-d", "--build", "--wait", "postgres", "rabbitmq"],
            )?;
            fv_ops::compose(
                &root,
                &c,
                &[
                    "exec",
                    "-T",
                    "postgres",
                    "psql",
                    "-U",
                    "postgres",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-q",
                    "-f",
                    "/run/fv/init.sql",
                ],
            )?;
            fv_ops::compose(
                &root,
                &c,
                &[
                    "exec",
                    "-T",
                    "rabbitmq",
                    "sh",
                    "-ceu",
                    "cp /run/fv/definitions.json /etc/rabbitmq/definitions.json; chown rabbitmq:rabbitmq /etc/rabbitmq/definitions.json; chmod 600 /etc/rabbitmq/definitions.json; rabbitmqctl import_definitions /etc/rabbitmq/definitions.json",
                ],
            )?;
            fv_ops::compose(&root, &c, &["up", "-d", "--wait", "hasura"])?;
            let env = fv_ops::env(&root, &c)?;
            for args in [
                vec!["--import", "tsx", "packages/database/migrate.ts"],
                vec!["--import", "tsx", "scripts/hasura.ts"],
            ] {
                fv_host::run("node", &args, &root, &env, 120)?;
            }
            if c.environment == "local" {
                fv_host::run(
                    "node",
                    &["--import", "tsx", "scripts/seed.ts"],
                    &root,
                    &env,
                    60,
                )?;
            }
            println!(
                "data stack ready; start application services with bin/dev or deploy a signed release"
            );
        }
        Cmd::QueueUpgrade => fv_host::run(
            "node",
            &["--import", "tsx", "scripts/queue-topology-upgrade.ts"],
            &root,
            &fv_ops::env(&root, &c)?,
            120,
        )?,
        Cmd::BrokerUpgrade => fv_host::run(
            "node",
            &["--import", "tsx", "scripts/broker-upgrade.ts"],
            &root,
            &fv_ops::env(&root, &c)?,
            1200,
        )?,
        Cmd::Down => fv_ops::compose(&root, &c, &["stop"])?,
        Cmd::Doctor => {
            fv_ops::validate_images(&root)?;
            fv_ops::compose(&root, &c, &["ps", "--format", "json"])?;
            let client = reqwest_client()?;
            for (name, url) in [
                ("database-backed API", "http://127.0.0.1:43801/health/ready"),
                ("admin", "http://127.0.0.1:43802/health/ready"),
            ] {
                ensure!(
                    client.get(url).send()?.status().is_success(),
                    "{name} not ready"
                );
            }
            println!(
                "local service readiness passed; external firewall/VPN/restore proof is separate"
            );
        }
        Cmd::Provision { action, public_key } => match action.as_str() {
            "plan" => println!(
                "{}",
                serde_json::to_string_pretty(&fv_provider::Hetzner::plan(&c))?
            ),
            "status" => println!("{}", fv_provider::Hetzner::new()?.status(&c)?),
            _ => {
                let public = fs::read_to_string(public_key.context("--public-key required")?)?;
                let init = fv_host::cloud_init(&c, &[public.trim().into()])?;
                let result = fv_provider::Hetzner::new()?.apply(&c, &init)?;
                private_write(
                    &root.join(format!(".state/{}/provider.json", c.environment)),
                    &serde_json::to_vec(&result)?,
                )?;
                println!("{result}");
            }
        },
        Cmd::Host { action } => {
            let script = root.join("infra/templates/converge.sh");
            if action == "plan" {
                println!(
                    "converge Linux host: Docker, firewall, systemd, private configuration; no public HTTP"
                )
            } else {
                ensure!(std::env::consts::OS == "linux", "host apply requires Linux");
                fv_host::assert_owned_host(&c)?;
                fv_host::install_tools(&root)?;
                let mut env = BTreeMap::new();
                env.insert("FV_ROOT".into(), root.to_string_lossy().into_owned());
                env.insert("FV_CONFIG".into(), a.config.to_string_lossy().into_owned());
                fv_host::run("bash", &[script.to_str().unwrap()], &root, &env, 900)?;
            }
        }
        Cmd::Release {
            action,
            revision,
            image,
            id,
        } => match action.as_str() {
            "prepare" => println!(
                "{}",
                fv_ops::deploy::prepare(
                    &root,
                    &c,
                    &revision.context("--revision required")?,
                    &image.context("--image required")?
                )?
            ),
            "deploy" => fv_ops::deploy::deploy(&root, &c, &id.context("--id required")?)?,
            "rollback" => fv_ops::deploy::rollback(&root, &c)?,
            _ => {
                drop(_lock);
                fv_host::run(
                    "node",
                    &["scripts/release-verify.ts"],
                    &root,
                    &fv_ops::env(&root, &c)?,
                    3600,
                )?;
            }
        },
        Cmd::Backup { action, kind } => match action.as_str() {
            "capture" => fv_ops::backup::capture(&root, &c, &kind)?,
            "verify" => fv_ops::backup::verify(&root, &c)?,
            _ => fv_ops::backup::restore_drill(&root, &c)?,
        },
        Cmd::Wireguard {
            action,
            name,
            public_key,
            address,
            expires,
        } => match action.as_str() {
            "enroll" => fv_ops::wireguard::enroll(
                &root,
                &c,
                &name.context("--name required")?,
                &public_key.context("--public-key required")?,
                &address.context("--address required")?,
                &expires.context("--expires required")?,
            )?,
            "revoke" => fv_ops::wireguard::revoke(&root, &c, &name.context("--name required")?)?,
            "apply" => fv_ops::wireguard::apply(&root, &c)?,
            _ => println!(
                "{}",
                serde_json::to_string_pretty(&fv_ops::wireguard::peers(&root, &c)?)?
            ),
        },
        Cmd::Ops { once } => loop {
            fv_ops::runner::tick(&root, &c)?;
            if once {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(3));
        },
        Cmd::AdminGrant {
            actor,
            actions,
            applications,
        } => {
            ensure!(
                !actor.is_empty() && !actions.is_empty() && !applications.is_empty(),
                "explicit actor and actions required"
            );
            let env = fv_ops::env(&root, &c)?;
            fv_host::run(
                "node",
                &[
                    "--import",
                    "tsx",
                    "scripts/admin-grant.ts",
                    &actor,
                    &actions.join(","),
                    &applications.join(","),
                ],
                &root,
                &env,
                30,
            )?;
        }
    }
    Ok(())
}
fn reqwest_client() -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()?)
}
