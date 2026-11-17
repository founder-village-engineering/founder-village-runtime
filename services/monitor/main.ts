import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { applicationPools } from "../../packages/database/applications.ts";
import { pool, secret } from "../../packages/database/index.ts";
import {
  server,
  shutdown,
  failure,
} from "../../packages/observability/index.ts";
import { equal } from "../../packages/auth/index.ts";
const apps = applicationPools("monitor"),
  control = pool("MONITOR_CONTROL_DATABASE_URL"),
  abort = new AbortController();
let lastAlerts: string[] = [];
let metrics = "";
async function sample() {
  const lines = [
    `fv_host_load ${os.loadavg()[0] ?? 0}`,
    `fv_host_free_memory_bytes ${os.freemem()}`,
  ];
  const alerts: string[] = [];
  const fs = await statfs(".");
  const free = fs.bavail / fs.blocks;
  lines.push(`fv_host_disk_free_ratio ${free}`);
  if (free < 0.15) alerts.push("host_disk_low");
  for (const [name, db] of Object.entries(apps)) {
    try {
      const result = await db.query<{
        metrics: { pending: number; dead: number };
        bytes: string;
      }>(
        "SELECT app.metrics() AS metrics,pg_database_size(current_database())::text AS bytes",
      );
      const row = result.rows[0]!;
      await control.query(
        "INSERT INTO control.namespace_status(application,healthy,pending,dead,database_bytes) VALUES($1,true,$2,$3,$4) ON CONFLICT(application) DO UPDATE SET healthy=true,pending=$2,dead=$3,database_bytes=$4,recorded_at=now()",
        [name, row.metrics.pending, row.metrics.dead, row.bytes],
      );
      lines.push(
        `fv_database_healthy{application="${name}"} 1`,
        `fv_jobs_pending{application="${name}"} ${row.metrics.pending}`,
        `fv_jobs_dead{application="${name}"} ${row.metrics.dead}`,
      );
      if (row.metrics.dead > 0) alerts.push(`dead_jobs:${name}`);
    } catch {
      alerts.push(`database_unavailable:${name}`);
      lines.push(`fv_database_healthy{application="${name}"} 0`);
    }
  }
  const result = await control.query<{ age: number | null }>(
    "SELECT extract(epoch FROM now()-max(created_at))::float AS age FROM control.backups WHERE verified",
  );
  const age = result.rows[0]?.age ?? Infinity;
  lines.push(`fv_backup_age_seconds ${age}`);
  if (age > 86400) alerts.push("backup_stale");
  metrics = lines.join("\n") + "\n";
  if (
    JSON.stringify(alerts) !== JSON.stringify(lastAlerts) &&
    process.env.ALERT_WEBHOOK_URL
  ) {
    const url = new URL(secret("ALERT_WEBHOOK_URL"));
    if (url.protocol !== "https:")
      throw new Error("HTTPS alert target required");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environment: secret("FV_ENV"),
        alerts,
        status: alerts.length ? "attention" : "recovered",
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("alert_delivery_failed");
    lastAlerts = alerts;
  }
}
const app = await server("monitor");
app.get("/metrics", async (req, reply) => {
  if (
    !equal(req.headers.authorization ?? "", `Bearer ${secret("MONITOR_TOKEN")}`)
  )
    return reply.code(401).send({ error: "unauthorized" });
  return reply.type("text/plain").send(metrics);
});
await app.listen({ host: "127.0.0.1", port: 43804 });
await shutdown(async () => {
  abort.abort();
  await app.close();
  await Promise.all([
    ...Object.values(apps).map((p) => p.end()),
    control.end(),
  ]);
});
while (!abort.signal.aborted) {
  try {
    await sample();
  } catch {
    failure("monitor.sample.failed");
  }
  await delay(30000, undefined, { signal: abort.signal }).catch(() => {});
}
