import { randomUUID } from "node:crypto";
import type pg from "pg";
import { transaction } from "../database/index.ts";
export async function schedule(db: pg.Pool) {
  return transaction(db, async (c) => {
    const lock = await c.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(51827004) AS locked",
    );
    if (!lock.rows[0]?.locked) return 0;
    const { rows } = await c.query<{
      id: string;
      next_run: Date;
      actor: string;
      interval_seconds: number;
    }>(
      "SELECT * FROM app.schedules WHERE enabled AND next_run<=now() ORDER BY next_run FOR UPDATE LIMIT 20",
    );
    for (const s of rows) {
      const inserted = await c.query(
        "INSERT INTO app.scheduler_runs(schedule_id,due_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING schedule_id",
        [s.id, s.next_run],
      );
      if (inserted.rowCount) {
        const tenants = await c.query<{ id: string }>(
          "SELECT id FROM app.tenants",
        );
        for (const t of tenants.rows)
          await c.query(
            "INSERT INTO app.outbox(id,tenant_id,record_id,actor,correlation_id,kind) VALUES($1,$2,$3,$4,$5,'maintenance.sweep')",
            [
              randomUUID(),
              t.id,
              "00000000-0000-4000-8000-000000000000",
              s.actor,
              randomUUID(),
            ],
          );
      }
      await c.query(
        "UPDATE app.schedules SET next_run=now()+interval_seconds*interval '1 second' WHERE id=$1",
        [s.id],
      );
    }
    return rows.length;
  });
}
