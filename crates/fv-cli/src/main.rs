use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use fv_config::private_write;
use std::{collections::BTreeMap, fs, path::PathBuf};
mod local;
mod start;
mod up;
#[derive(Parser)]
#[command(version, about = "Founder Village runtime control")]
struct Args {
    #[arg(long, global = true, default_value = ".")]
    root: PathBuf,
    #[arg(long, global = true, default_value = "config/local.json")]
    config: PathBuf,
    #[command(subcommand)]
    command: Cmd,
}
#[derive(Subcommand)]
enum Cmd {
    /// Open the interactive runtime menu (or run a named shortcut).
    Start {
        #[arg(value_enum)]
        action: Option<start::Action>,
        /// List shortcuts without executing anything; also used without a TTY.
        #[arg(long, conflicts_with = "action")]
        list: bool,
    },
    /// Manage the isolated local *.fv DNS and HTTPS edge.
    LocalEdge {
        #[arg(value_parser = ["plan", "setup", "up", "doctor", "down", "host-install"])]
        action: String,
    },
    /// Issue a five-minute, single-use local administrator sign-in link.
    AdminLogin {
        #[arg(long)]
        open: bool,
    },
    /// Run one fixed local service with its scoped environment.
    Dev {
        #[arg(value_parser = ["api", "admin", "workers", "domain-worker", "monitor"])]
        service: String,
    },
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
    if let Cmd::Start { action, list } = a.command {
        return start::run(&root, &a.config, action, list);
    }
    let c = fv_config::load(&root.join(&a.config))?;
    if matches!(a.command, Cmd::Validate) {
        fv_ops::validate_images(&root)?;
        if c.environment == "local" {
            fv_ops::local_edge::routes(&root, &c)?;
        }
        println!("configuration valid");
        return Ok(());
    }
    let _lock = if matches!(
        a.command,
        Cmd::Ops { .. } | Cmd::LocalEdge { .. } | Cmd::Dev { .. }
    ) {
        None
    } else {
        Some(fv_ops::lock(&root, &c)?)
    };
    match a.command {
        Cmd::Start { .. } => unreachable!(),
        Cmd::Dev { service } => local::run_service(&root, &c, &service)?,
        Cmd::AdminLogin { open } => {
            ensure!(
                c.environment == "local",
                "remote administrators require OIDC MFA"
            );
            let mut args = vec!["--import", "tsx", "scripts/admin-login.ts"];
            if open {
                args.push("--open");
            }
            fv_host::run("node", &args, &root, &fv_ops::env(&root, &c)?, 30)?;
        }
        Cmd::LocalEdge { action } => match action.as_str() {
            "plan" => fv_ops::local_edge::plan(&root, &c)?,
            "up" => fv_ops::local_edge::up(&root, &c)?,
            "setup" => fv_ops::local_edge::setup(&root, &c)?,
            "doctor" => fv_ops::local_edge::doctor(&root, &c)?,
            "host-install" => fv_ops::local_edge::host_install(&root, &c)?,
            _ => fv_ops::local_edge::down(&root, &c)?,
        },
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
            up::run(&root, &c, fv_host::run_command)?;
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
        Cmd::Ops { once } => {
            let interrupt = local::Interrupt::new()?;
            while !interrupt.stopped() {
                fv_ops::runner::tick(&root, &c)?;
                if once {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_secs(3));
            }
        }
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
