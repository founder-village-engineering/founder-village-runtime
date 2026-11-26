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
    /// Start or stop the outbound tunnel for a promoted remote release.
    Ingress {
        #[arg(value_parser = ["up", "down"])]
        action: String,
    },
    BrokerUpgrade,
    QueueUpgrade,
    /// Audit the private provider binding for an existing remote VM.
    CandidateAudit,
    #[command(hide = true)]
    BundleExtract {
        directory: PathBuf,
        destination: PathBuf,
        architecture: String,
    },
    #[command(hide = true)]
    BundleCheck {
        generation: PathBuf,
        architecture: String,
    },
    Provision {
        #[arg(value_parser=["plan","apply","status","audit"])]
        action: String,
        #[arg(long)]
        public_key: Option<PathBuf>,
        /// Console-verified known_hosts for checking operator SSH before firewall lockdown.
        #[arg(long)]
        tunnel_known_hosts: Option<PathBuf>,
        #[arg(long, requires = "tunnel_known_hosts")]
        tunnel_identity: Option<PathBuf>,
    },
    Host {
        #[arg(value_parser=["plan","apply","install-catalog","escrow-backup-verifier","seal-ssh"])]
        action: String,
    },
    Release {
        #[arg(value_parser=["prepare","deploy","stage","promote","rollback","verify"])]
        action: String,
        #[arg(long)]
        revision: Option<String>,
        #[arg(long)]
        image: Option<String>,
        #[arg(long)]
        id: Option<String>,
    },
    Backup {
        #[arg(value_parser=["capture","verify","restore-drill","export-info","export","import-drill"])]
        action: String,
        #[arg(long, default_value = "full")]
        kind: String,
    },
    /// Invite a user over the host-only Vaultwarden admin route.
    VaultwardenInvite,
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
    if let Cmd::BundleExtract {
        directory,
        destination,
        architecture,
    } = &a.command
    {
        let arch = fv_config::Architecture::from_machine(architecture)?;
        return fv_ops::workstation::extract(
            &directory.canonicalize()?,
            &destination.canonicalize()?,
            arch,
        );
    }
    if let Cmd::BundleCheck {
        generation,
        architecture,
    } = &a.command
    {
        let m = fv_ops::workstation::Manifest::read(
            &generation.join(".bundle"),
            std::path::Path::new(fv_ops::workstation::SIGNERS),
            fv_config::Architecture::from_machine(architecture)?,
        )?;
        m.verify_archive(generation)?;
        return m.verify_source(generation);
    }
    if let Cmd::Start { action, list } = a.command {
        return start::run(&root, &a.config, action, list);
    }
    if matches!(a.command, Cmd::CandidateAudit) {
        let candidate = fv_config::load_provider_candidate(&root.join(&a.config))?;
        println!(
            "{}",
            serde_json::to_string_pretty(&fv_provider::Hetzner::audit_candidate(&candidate)?)?
        );
        return Ok(());
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
    ) || matches!(&a.command, Cmd::Provision { action, .. } if action != "apply")
    {
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
        Cmd::BundleExtract { .. } | Cmd::BundleCheck { .. } => unreachable!(),
        Cmd::Validate => {}
        Cmd::CandidateAudit => unreachable!("candidate audit uses a provider-only manifest"),
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
            if c.environment == "local" {
                println!("data stack ready; start local application services with bin/dev");
            } else {
                println!(
                    "data stack ready; previously promoted application services resumed if present"
                );
            }
        }
        Cmd::Down => {
            if c.environment == "local" {
                fv_ops::compose(&root, &c, &["stop"])?;
            } else {
                fv_ops::compose(
                    &root,
                    &c,
                    &[
                        "--profile",
                        "applications",
                        "--profile",
                        "ingress",
                        "--profile",
                        "vaultwarden",
                        "stop",
                    ],
                )?;
            }
        }
        Cmd::Ingress { action } => {
            ensure!(
                c.environment != "local",
                "public ingress requires a remote manifest"
            );
            if action == "down" {
                fv_ops::compose(&root, &c, &["--profile", "ingress", "stop", "cloudflared"])?;
            } else {
                fv_host::assert_platform(&c)?;
                ensure!(
                    !c.cloudflare.access_aud.is_empty()
                        && c.tunnel_domains().all(|name| c
                            .cloudflare
                            .managed_names
                            .iter()
                            .any(|managed| managed == name)),
                    "configure the tunnel routes and the Cloudflare Access audience"
                );
                let token = root.join(format!(".state/{}/tunnel/token", c.environment));
                let metadata = token
                    .symlink_metadata()
                    .context("missing private tunnel token")?;
                ensure!(
                    metadata.is_file() && metadata.len() > 0,
                    "invalid private tunnel token"
                );
                fv_ops::deploy::check_serving(&root, &c)?;
                fv_ops::compose(
                    &root,
                    &c,
                    &[
                        "--profile",
                        "ingress",
                        "up",
                        "-d",
                        "--no-deps",
                        "--no-build",
                        "--pull",
                        "never",
                        "cloudflared",
                    ],
                )?;
                println!("tunnel connector started; verify the public endpoints externally");
            }
        }
        Cmd::QueueUpgrade => fv_host::run(
            "node",
            &["--import", "tsx", "scripts/queue-topology-upgrade.ts"],
            &root,
            &fv_ops::env(&root, &c)?,
            120,
        )?,
        Cmd::BrokerUpgrade => {
            if c.environment != "local" {
                fv_ops::workstation::Manifest::installed(&root, c.provider.architecture)?
                    .load_images(&root)?;
            }
            fv_host::run(
                "node",
                &["--import", "tsx", "scripts/broker-upgrade.ts"],
                &root,
                &fv_ops::env(&root, &c)?,
                1200,
            )?;
        }
        Cmd::Doctor => {
            fv_ops::validate_images(&root)?;
            fv_ops::compose(&root, &c, &["ps", "--format", "json"])?;
            if c.environment != "local" {
                fv_host::assert_platform(&c)?;
                ensure!(
                    fv_host::docker_architecture()? == c.provider.architecture,
                    "Docker architecture mismatch"
                );
                let revision = fv_ops::deploy::check_serving(&root, &c)?;
                println!(
                    "private proxy ready on linux/{}; serving revision {revision}",
                    c.provider.architecture.oci()
                );
                return Ok(());
            }
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
        Cmd::Provision {
            action,
            public_key,
            tunnel_known_hosts,
            tunnel_identity,
        } => match action.as_str() {
            "plan" => println!(
                "{}",
                serde_json::to_string_pretty(&fv_provider::Hetzner::plan(&c))?
            ),
            "status" => println!("{}", fv_provider::Hetzner::new()?.status(&c)?),
            "audit" => println!("{}", fv_provider::Hetzner::new()?.audit(&c)?),
            _ => {
                if let Some(host) = &c.cloudflare.ssh_domain
                    && c.ssh_cidrs.is_empty()
                {
                    fv_host::verify_tunnel_ssh(
                        &root,
                        host,
                        &tunnel_known_hosts.context(
                            "--tunnel-known-hosts is required to close public inbound access",
                        )?,
                        tunnel_identity.as_deref(),
                    )?;
                }
                let init = public_key
                    .map(fs::read_to_string)
                    .transpose()?
                    .map(|public| fv_host::cloud_init(&c, &[public.trim().into()]))
                    .transpose()?;
                let result = fv_provider::Hetzner::new()?.apply(&c, init.as_deref())?;
                private_write(
                    &root.join(format!(".state/{}/provider.json", c.environment)),
                    &serde_json::to_vec(&result)?,
                )?;
                println!("Hetzner resources converged; private provider receipt saved");
            }
        },
        Cmd::Host { action } => {
            let script = root.join("infra/templates/converge.sh");
            if action == "plan" {
                println!(
                    "converge Linux host: Docker, firewall, systemd, private configuration; no public HTTP"
                )
            } else {
                fv_host::assert_platform(&c)?;
                fv_host::assert_owned_host(&c)?;
                if action == "install-catalog" {
                    return fv_ops::render::install_catalog(&root, &c, std::io::stdin().lock());
                }
                if action == "escrow-backup-verifier" {
                    return fv_ops::backup::escrow_verifier(&root, &c);
                }
                let installed =
                    fv_ops::workstation::Manifest::installed(&root, c.provider.architecture)?;
                installed.verify_source(&root.join(".fv-current"))?;
                if action == "seal-ssh" {
                    ensure!(c.cloudflare.ssh_domain.is_some(), "Tunnel SSH required");
                    let active = root
                        .join(".state/private-config")
                        .join(format!("{}.private.json", c.environment));
                    ensure!(
                        active.canonicalize()? == root.join(&a.config).canonicalize()?,
                        "use the active installed configuration"
                    );
                    let mut sealed = c.clone();
                    sealed.ssh_cidrs.clear();
                    sealed.validate()?;
                    private_write(&active, &serde_json::to_vec_pretty(&sealed)?)?;
                }
                let mut env = BTreeMap::new();
                env.insert("FV_ROOT".into(), root.to_string_lossy().into_owned());
                env.insert(
                    "FV_CONFIG".into(),
                    root.join(a.config)
                        .canonicalize()?
                        .to_string_lossy()
                        .into_owned(),
                );
                env.insert("FV_ARCH".into(), c.provider.architecture.oci().into());
                env.insert("FV_HOST_IMAGE".into(), c.provider.image.clone());
                if c.cloudflare.ssh_domain.is_some() {
                    env.insert(
                        "FV_TUNNEL_SSH_INTERFACE".into(),
                        fv_config::TUNNEL_SSH_INTERFACE.into(),
                    );
                    env.insert(
                        "FV_TUNNEL_SSH_GATEWAY".into(),
                        fv_config::TUNNEL_SSH_GATEWAY.into(),
                    );
                }
                if action == "seal-ssh" {
                    let firewall = root.join("infra/templates/ssh-firewall.sh");
                    return fv_host::run("bash", &[firewall.to_str().unwrap()], &root, &env, 90);
                }
                fv_host::run("bash", &[script.to_str().unwrap()], &root, &env, 900)?;
                installed.load_images(&root)?;
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
            "stage" => {
                fv_host::assert_platform(&c)?;
                fv_host::assert_owned_host(&c)?;
                let rev = revision.context("--revision required")?;
                let manifest =
                    fv_ops::workstation::Manifest::retained(&root, &rev, c.provider.architecture)?;
                manifest.verify_source(&root.join(".fv-releases").join(&rev))?;
                manifest.load_images(&root)?;
            }
            "promote" => {
                ensure!(
                    image.is_none() && id.is_none(),
                    "promote selects the installed signed image"
                );
                let revision = revision.context("--revision required")?;
                fv_ops::deploy::promote_installed(&root, &c, &revision)?;
                println!("Promoted installed signed runtime {revision}");
            }
            "rollback" => fv_ops::deploy::rollback(&root, &c)?,
            _ if c.environment != "local" => {
                let manifest =
                    fv_ops::workstation::Manifest::installed(&root, c.provider.architecture)?;
                manifest.verify_source(&root.join(".fv-current"))?;
                manifest.verify_images(&root)?;
                manifest.verify_archive(&root.join(".fv-current"))?;
                fv_ops::deploy::check_serving(&root, &c)?;
                fv_ops::backup::verify(&root, &c)?;
            }
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
            "export-info" => fv_ops::backup::export_snapshot(&root, &c, false)?,
            "export" => fv_ops::backup::export_snapshot(&root, &c, true)?,
            "import-drill" => fv_ops::backup::import_drill(&root, &c)?,
            _ => fv_ops::backup::restore_drill(&root, &c)?,
        },
        Cmd::VaultwardenInvite => {
            fv_ops::vaultwarden::invite(&root, &c, std::io::stdin().lock())?;
            println!("Vaultwarden invitation created");
        }
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
