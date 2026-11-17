import { authorizeOperation } from "../../packages/operations/authorize.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  applicationPools,
  selectApplication,
} from "../../packages/database/applications.ts";
import {
  pool,
  audit,
  transaction,
  secret,
} from "../../packages/database/index.ts";
import { operation, type Operation } from "../../packages/contracts/index.ts";
import { environment } from "../../packages/auth/index.ts";
import {
  Cloudflare,
  fingerprint,
  type DnsRecord,
  type Existing,
} from "../../packages/operations/cloudflare.ts";
import { archiveAudit } from "../../packages/operations/audit.ts";
import { failure, shutdown } from "../../packages/observability/index.ts";
const db = pool("RUNNER_DATABASE_URL"),
  apps = applicationPools("worker"),
  stop = new AbortController();
export async function tick() {
  const job = await transaction(db, async (c) => {
    const { rows } = await c.query<{
      id: string;
      actor: string;
      action: string;
      parameters: unknown;
      environment: string;
      enabled: boolean;
      actions: string[];
      applications: string[];
    }>(
      "SELECT o.id,o.actor,o.action,o.parameters,o.environment,a.enabled,a.actions,a.applications FROM control.operations o JOIN control.administrators a ON a.actor=o.actor WHERE o.state='queued' AND o.action IN ('dns.apply','jobs.retry','audit.archive','schedules.manage') ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1",
    );
    const row = rows[0];
    if (!row) return null;
    if (
      !row.enabled ||
      !row.actions.includes(row.action) ||
      row.environment !== environment()
    ) {
      await c.query(
        "UPDATE control.operations SET state='failed',result='{\"error\":\"authorization_revoked\"}' WHERE id=$1",
        [row.id],
      );
      await audit(c, row.actor, row.action, row.id, "denied", row.id);
      return null;
    }
    await c.query(
      "UPDATE control.operations SET state='running',attempts=attempts+1,lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=$1",
      [row.id],
    );
    return row;
  });
  if (!job) return;
  let status = "succeeded";
  try {
    await authorizeOperation(db, {
      id: job.id,
      actor: job.actor,
      environment: environment() as "local" | "staging" | "production",
      action: job.action,
      parameters: job.parameters as Record<string, unknown>,
    });
    const parsed: Operation = operation.parse({
      action: job.action,
      parameters: job.parameters,
    });
    if (
      "application" in parsed.parameters &&
      !job.applications.includes(parsed.parameters.application)
    )
      throw new Error("application grant revoked");
    if (parsed.action === "dns.apply") {
      const { rows } = await db.query<{
        actor: string;
        zone_id: string;
        record_name: string;
        before_state: Existing | null;
        desired: DnsRecord | null;
        fingerprint: string;
        valid: boolean;
      }>(
        "SELECT *,expires_at>now() AND applied_at IS NULL AS valid FROM control.dns_plans WHERE id=$1",
        [parsed.parameters.planId],
      );
      const plan = rows[0];
      if (
        !plan ||
        plan.actor !== job.actor ||
        !plan.valid ||
        plan.zone_id !== secret("CF_ZONE_ID") ||
        fingerprint({ before: plan.before_state, desired: plan.desired }) !==
          plan.fingerprint
      )
        throw new Error("invalid DNS plan");
      await new Cloudflare(true).apply(
        plan.record_name,
        plan.before_state,
        plan.desired,
      );
      await db.query(
        "UPDATE control.dns_plans SET applied_at=now() WHERE id=$1",
        [parsed.parameters.planId],
      );
    } else if (parsed.action === "jobs.retry") {
      const { rowCount } = await selectApplication(
        apps,
        parsed.parameters.application,
      ).query(
        "UPDATE app.outbox SET state='pending',attempts=0,available_at=now(),last_error=NULL WHERE id=$1 AND state='dead'",
        [parsed.parameters.jobId],
      );
      if (!rowCount) throw new Error("job not dead");
    } else if (parsed.action === "audit.archive") await archiveAudit(db);
    else if (parsed.action === "schedules.manage")
      await selectApplication(apps, parsed.parameters.application).query(
        "INSERT INTO app.schedules(id,name,interval_seconds,next_run,actor) VALUES(gen_random_uuid(),$1,$2,now(),$3) ON CONFLICT(name) DO UPDATE SET interval_seconds=$2,actor=$3",
        [parsed.parameters.name, parsed.parameters.intervalSeconds, job.actor],
      );
    else throw new Error("unsupported domain operation");
  } catch {
    status = "failed";
    failure("operation.failed");
  }
  await transaction(db, async (c) => {
    await c.query(
      "UPDATE control.operations SET state=$2,result=$3,lease_until=NULL,updated_at=now() WHERE id=$1",
      [job.id, status, { status }],
    );
    await audit(c, job.actor, job.action, job.id, status, job.id);
  });
}
await shutdown(async () => {
  stop.abort();
  await Promise.all([db.end(), ...Object.values(apps).map((p) => p.end())]);
});
while (!stop.signal.aborted) {
  try {
    await tick();
  } catch {
    failure("domain_worker.failed");
  }
  await delay(2000, undefined, { signal: stop.signal }).catch(() => {});
}
