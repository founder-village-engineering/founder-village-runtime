use anyhow::{Context, Result, ensure};
use clap::ValueEnum;
use crossterm::{
    cursor::{Hide, MoveTo, Show},
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute, queue,
    style::{Color, Print, ResetColor, SetForegroundColor},
    terminal::{self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use std::{
    io::{self, IsTerminal, Write},
    path::Path,
    process::Command,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum Action {
    Local,
    AdminLogin,
    LocalEdge,
    EdgeDoctor,
    Up,
    Doctor,
    Down,
    Check,
    ReleaseVerify,
    Backup,
    BackupVerify,
    RestoreDrill,
    ReleasePrepare,
    ReleaseDeploy,
    ReleaseRollback,
    Validate,
}

impl Action {
    fn key(self) -> String {
        self.to_possible_value().unwrap().get_name().to_owned()
    }

    fn label(self) -> &'static str {
        match self {
            Self::Local => "Start local servers",
            Self::AdminLogin => "Sign in to local admin",
            Self::LocalEdge => "Set up local .fv HTTPS and DNS",
            Self::EdgeDoctor => "Check local .fv DNS and TLS",
            Self::Up => "Start data stack / apply migrations",
            Self::Doctor => "Check runtime health",
            Self::Down => "Stop data stack (keep volumes)",
            Self::Check => "Run routine code checks",
            Self::ReleaseVerify => "Run full local release verification",
            Self::Backup => "Capture encrypted backup",
            Self::BackupVerify => "Verify backup inventory",
            Self::RestoreDrill => "Run isolated restore drill",
            Self::ReleasePrepare => "Prepare signed-image release",
            Self::ReleaseDeploy => "Deploy prepared release",
            Self::ReleaseRollback => "Roll back serving release",
            Self::Validate => "Validate runtime configuration",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::AdminLogin => {
                "Issue a five-minute, single-use sign-in link and open the local HTTPS admin panel."
            }
            Self::LocalEdge => {
                "Install the dedicated local DNS resolver and CA trust; macOS requests administrator authentication once."
            }
            Self::EdgeDoctor => {
                "Verify OS DNS, certificates and all registered one-level HTTPS routes; report upstream status separately."
            }
            Self::Local => {
                "Build console, start fv-local, API, admin, workers, monitor and operation runners; Ctrl-C stops owned servers."
            }
            Self::Up => {
                "Initialize private configuration, start PostgreSQL/RabbitMQ/Hasura, migrate and seed local fixtures."
            }
            Self::Doctor => "Run the existing Compose and API/admin readiness checks.",
            Self::Down => {
                "Stop only the configured Compose project; preserve data volumes and separately started host services."
            }
            Self::Check => "Run npm run check and Rust Clippy; no provider or release operations.",
            Self::ReleaseVerify => {
                "Run the explicit expanded local release workflow, including integration, browser and recovery checks. Stop local servers first."
            }
            Self::Backup => "Capture a full encrypted backup using the configured backup catalog.",
            Self::BackupVerify => {
                "Verify existing backup receipts and inventory; offsite and clean-host recovery remain separate evidence."
            }
            Self::RestoreDrill => {
                "Restore into an isolated recovery container using the existing recovery procedure."
            }
            Self::ReleasePrepare => {
                "Enter an exact source SHA and immutable image digest; bind the manifest to this configuration."
            }
            Self::ReleaseDeploy => {
                "Enter a prepared release ID; retain signature, backup, migration, readiness and rollback gates. Runs on this host."
            }
            Self::ReleaseRollback => {
                "Use the previous verified release for this configured environment. Runs on this host."
            }
            Self::Validate => "Validate configuration and pinned images without starting services.",
        }
    }

    fn command(self) -> &'static [&'static str] {
        match self {
            Self::AdminLogin => &["admin-login", "--open"],
            Self::LocalEdge => &["local-edge", "setup"],
            Self::EdgeDoctor => &["local-edge", "doctor"],
            Self::Up => &["up"],
            Self::Doctor => &["doctor"],
            Self::Down => &["down"],
            Self::ReleaseVerify => &["release", "verify"],
            Self::Backup => &["backup", "capture"],
            Self::BackupVerify => &["backup", "verify"],
            Self::RestoreDrill => &["backup", "restore-drill"],
            Self::ReleasePrepare => &["release", "prepare"],
            Self::ReleaseDeploy => &["release", "deploy"],
            Self::ReleaseRollback => &["release", "rollback"],
            Self::Validate => &["validate"],
            Self::Local | Self::Check => &[],
        }
    }
}

pub fn run(root: &Path, config: &Path, action: Option<Action>, list: bool) -> Result<()> {
    if list || (action.is_none() && !interactive()) {
        println!("Founder Village runtime — bin/fv start <action>\n");
        for action in Action::value_variants() {
            println!("  {:<18} {}", action.key(), action.label());
        }
        println!(
            "\nUse npm start in a terminal for the menu. Default configuration: config/local.json."
        );
        return Ok(());
    }
    let c = fv_config::load(&root.join(config))?;
    let action = match action {
        Some(action) => Some(action),
        None => select(&c, config)?,
    };
    let Some(action) = action else {
        return Ok(());
    };
    println!("{} — {} ({})", action.label(), c.environment, c.project);
    if action == Action::Local {
        return crate::local::run(root, config, &c);
    }
    if action == Action::Check {
        status(Command::new("npm").args(["run", "check"]).current_dir(root))?;
        return status(
            Command::new("cargo")
                .args([
                    "clippy",
                    "--locked",
                    "--workspace",
                    "--all-targets",
                    "--",
                    "-D",
                    "warnings",
                ])
                .current_dir(root),
        );
    }
    if action == Action::ReleaseVerify {
        ensure!(
            c.environment == "local",
            "full release verification uses local fixtures; select config/local.json"
        );
    }
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--root")
        .arg(root)
        .arg("--config")
        .arg(config)
        .args(action.command())
        .current_dir(root);
    match action {
        Action::ReleasePrepare => {
            let Some(revision) = prompt("Exact 40-character source SHA")? else {
                return Ok(());
            };
            let Some(image) = prompt("Approved image@sha256:digest")? else {
                return Ok(());
            };
            command.args(["--revision", &revision, "--image", &image]);
        }
        Action::ReleaseDeploy => {
            let Some(id) = prompt("Prepared release ID")? else {
                return Ok(());
            };
            command.args(["--id", &id]);
        }
        _ => {}
    }
    status(&mut command)
}

fn status(command: &mut Command) -> Result<()> {
    let status = command.status().context("could not execute shortcut")?;
    ensure!(status.success(), "shortcut failed ({status})");
    Ok(())
}

fn interactive() -> bool {
    io::stdin().is_terminal() && io::stdout().is_terminal()
}

fn prompt(label: &str) -> Result<Option<String>> {
    ensure!(
        interactive(),
        "this shortcut needs a terminal; use bin/fv release with explicit arguments for automation"
    );
    print!("{label} (blank cancels): ");
    io::stdout().flush()?;
    let mut value = String::new();
    io::stdin().read_line(&mut value)?;
    let value = value.trim();
    if value.is_empty() {
        println!("Cancelled.");
        return Ok(None);
    }
    ensure!(
        !value.chars().any(char::is_control),
        "control characters are not allowed"
    );
    Ok(Some(value.into()))
}

struct Terminal;
impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
        let _ = execute!(io::stdout(), Show, ResetColor, LeaveAlternateScreen);
    }
}

fn clipped(text: &str, width: u16) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(width.saturating_sub(1) as usize)
        .collect()
}

fn select(c: &fv_config::Config, config: &Path) -> Result<Option<Action>> {
    let _terminal = Terminal;
    terminal::enable_raw_mode()?;
    let mut out = io::stdout();
    execute!(out, EnterAlternateScreen, Hide)?;
    let actions = Action::value_variants();
    let mut cursor: usize = 0;
    loop {
        let (width, height) = terminal::size()?;
        let visible = usize::from(height.saturating_sub(8)).max(1);
        let first = cursor.saturating_sub(visible - 1);
        queue!(
            out,
            MoveTo(0, 0),
            Clear(ClearType::All),
            SetForegroundColor(Color::Cyan),
            Print("Founder Village runtime\r\n"),
            ResetColor
        )?;
        queue!(
            out,
            Print(clipped(
                &format!("{} / {} — {}", c.environment, c.project, config.display()),
                width
            )),
            Print("\r\n\r\n")
        )?;
        for (index, action) in actions.iter().enumerate().skip(first).take(visible) {
            queue!(
                out,
                SetForegroundColor(if index == cursor {
                    Color::Cyan
                } else {
                    Color::Grey
                }),
                Print(clipped(
                    &format!(
                        "{} {:<18} {}",
                        if index == cursor { ">" } else { " " },
                        action.key(),
                        action.label()
                    ),
                    width
                )),
                Print("\r\n")
            )?;
        }
        queue!(
            out,
            ResetColor,
            Print("\r\n"),
            Print(clipped(actions[cursor].description(), width)),
            Print("\r\n\r\n"),
            Print(clipped(
                "Up/Down or j/k: choose | Enter: run | Esc/q/Ctrl-C: exit",
                width
            ))
        )?;
        out.flush()?;
        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Press {
                continue;
            }
            match key.code {
                KeyCode::Up | KeyCode::Char('k') => {
                    cursor = (cursor + actions.len() - 1) % actions.len()
                }
                KeyCode::Down | KeyCode::Char('j') => cursor = (cursor + 1) % actions.len(),
                KeyCode::Enter => return Ok(Some(actions[cursor])),
                KeyCode::Esc | KeyCode::Char('q') => return Ok(None),
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    return Ok(None);
                }
                _ => {}
            }
        }
    }
}
