use anyhow::Result;
use fv_config::Config;
use std::{path::Path, process::Command};

// Both `fv up` and the local supervisor use this sequence. The supervisor owns
// each setup process directly so cancellation also cleans up its descendants.
pub fn run(
    root: &Path,
    c: &Config,
    mut execute: impl FnMut(&mut Command, u64) -> Result<()>,
) -> Result<()> {
    fv_ops::render::init(root, c)?;
    for args in [
        vec!["up", "-d", "--build", "--wait", "postgres", "rabbitmq"],
        vec![
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
        vec![
            "exec",
            "-T",
            "rabbitmq",
            "sh",
            "-ceu",
            "cp /run/fv/definitions.json /etc/rabbitmq/definitions.json; chown rabbitmq:rabbitmq /etc/rabbitmq/definitions.json; chmod 600 /etc/rabbitmq/definitions.json; rabbitmqctl import_definitions /etc/rabbitmq/definitions.json",
        ],
        vec!["up", "-d", "--wait", "hasura"],
    ] {
        execute(&mut fv_ops::compose_command(root, c, &args), 3600)?;
    }
    let env = fv_ops::env(root, c)?;
    for script in ["packages/database/migrate.ts", "scripts/hasura.ts"]
        .into_iter()
        .chain((c.environment == "local").then_some("scripts/seed.ts"))
    {
        execute(
            Command::new("node")
                .args(["--import", "tsx", script])
                .current_dir(root)
                .envs(&env),
            120,
        )?;
    }
    Ok(())
}
