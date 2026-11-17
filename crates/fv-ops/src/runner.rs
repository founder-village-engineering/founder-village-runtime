use anyhow::{Result, ensure};
use fv_config::Config;
use serde_json::{Value, json};
use std::path::Path;
pub fn tick(root: &Path, c: &Config) -> Result<bool> {
    let Ok(_lease) = super::lock(root, c) else {
        return Ok(false);
    };
    let mut db = super::client(root, c)?;
    let mut tx = db.transaction()?;
    tx.execute("UPDATE control.operations SET state='failed',result='{\"error\":\"lease_expired_reconcile_before_retry\"}',updated_at=now() WHERE state='running' AND lease_until<now()",&[])?;
    let row=tx.query_opt("SELECT o.id::text,o.actor,o.action,o.parameters::text,o.environment,a.enabled,a.actions,a.applications FROM control.operations o JOIN control.administrators a ON a.actor=o.actor WHERE o.state='queued' AND o.action=ANY($1) ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1",&[&vec!["backup.capture","backup.verify","backup.restore-drill","deploy.release","deploy.rollback","wireguard.revoke"]])?;
    let Some(row) = row else {
        tx.commit()?;
        return Ok(false);
    };
    let id: String = row.get(0);
    let actor: String = row.get(1);
    let action: String = row.get(2);
    let params: Value = serde_json::from_str(row.get::<_, &str>(3))?;
    let environment: String = row.get(4);
    let enabled: bool = row.get(5);
    let grants: Vec<String> = row.get(6);
    let scopes: Vec<String> = row.get(7);
    if environment != c.environment
        || !enabled
        || !grants.contains(&action)
        || !fv_config::applications(root)?
            .iter()
            .all(|app| scopes.contains(&app.id))
    {
        tx.execute("UPDATE control.operations SET state='failed',result='{\"error\":\"authorization_revoked\"}' WHERE id=$1::text::uuid",&[&id])?;
        tx.execute(
            "SELECT control.append_audit($1,$2,$3,'denied',$3::text::uuid)",
            &[&actor, &action, &id],
        )?;
        tx.commit()?;
        return Ok(true);
    }
    tx.execute("UPDATE control.operations SET state='running',attempts=attempts+1,lease_until=now()+interval '1 hour',updated_at=now() WHERE id=$1::text::uuid",&[&id])?;
    tx.commit()?;
    let result = (|| -> Result<()> {
        let assertion_file =
            root.join(format!(".state/{}/operation-assertion.json", c.environment));
        fv_config::private_write(
            &assertion_file,
            &serde_json::to_vec(
                &json!({"id":id,"actor":actor,"environment":c.environment,"action":action,"parameters":params}),
            )?,
        )?;
        fv_host::run(
            "node",
            &[
                "--import",
                "tsx",
                "scripts/verify-operation.ts",
                assertion_file.to_str().unwrap(),
            ],
            root,
            &super::env(root, c)?,
            30,
        )?;
        let p = params
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("invalid parameters"))?;
        match action.as_str() {
            "backup.capture" => {
                ensure!(p.len() == 1, "unexpected parameters");
                super::backup::capture(
                    root,
                    c,
                    p.get("type").and_then(Value::as_str).unwrap_or("diff"),
                )
            }
            "backup.verify" => {
                ensure!(p.is_empty(), "unexpected parameters");
                super::backup::verify(root, c)
            }
            "backup.restore-drill" => {
                ensure!(p.is_empty(), "unexpected parameters");
                super::backup::restore_drill(root, c)
            }
            "deploy.release" => {
                ensure!(p.len() == 1, "unexpected parameters");
                super::deploy::deploy(
                    root,
                    c,
                    p.get("release").and_then(Value::as_str).unwrap_or(""),
                )
            }
            "deploy.rollback" => {
                ensure!(p.is_empty(), "unexpected parameters");
                super::deploy::rollback(root, c)
            }
            "wireguard.revoke" => {
                ensure!(p.len() == 1, "unexpected parameters");
                super::wireguard::revoke(
                    root,
                    c,
                    p.get("name").and_then(Value::as_str).unwrap_or(""),
                )?;
                super::wireguard::apply(root, c)
            }
            _ => anyhow::bail!("unsupported action"),
        }
    })();
    let state = if result.is_ok() {
        "succeeded"
    } else {
        "failed"
    };
    let outcome = json!({"status":state}).to_string();
    db.execute("UPDATE control.operations SET state=$2,result=$3::text::jsonb,lease_until=NULL,updated_at=now() WHERE id=$1::text::uuid",&[&id,&state,&outcome])?;
    db.execute(
        "SELECT control.append_audit($1,$2,$3,$4,$3::text::uuid)",
        &[&actor, &action, &id, &state],
    )?;
    Ok(true)
}
