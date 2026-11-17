import pg from "pg";
import { readFileSync } from "node:fs";
export function secret(name: string): string {
  const file = process.env[`${name}_FILE`];
  const value = file ? readFileSync(file, "utf8").trim() : process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
export function pool(name = "DATABASE_URL"): pg.Pool {
  return new pg.Pool({
    connectionString: secret(name),
    max: 4,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    application_name: `fv-${process.env.FV_SERVICE ?? "cli"}`,
  });
}
export async function transaction<T>(
  db: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await db.connect();
  let discard = false;
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch {
      // The transaction state is unknown: never return this connection to the
      // pool, and retain the original failure without exposing SQL diagnostics.
      discard = true;
    }
    throw e;
  } finally {
    c.release(discard);
  }
}
export async function tenant<T>(
  db: pg.Pool,
  actor: string,
  tenantId: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return transaction(db, async (c) => {
    await c.query(
      "SELECT set_config('fv.actor',$1,true),set_config('fv.tenant',$2,true)",
      [actor, tenantId],
    );
    const { rows } = await c.query<{ allowed: boolean }>(
      "SELECT app.is_member($1::uuid) AS allowed",
      [tenantId],
    );
    if (!rows[0]?.allowed)
      throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    return fn(c);
  });
}
export async function audit(
  db: pg.Pool | pg.PoolClient,
  actor: string,
  event: string,
  resource: string,
  outcome: string,
  id?: string,
): Promise<void> {
  await db.query("SELECT control.append_audit($1,$2,$3,$4,$5::uuid)", [
    actor,
    event,
    resource,
    outcome,
    id ?? null,
  ]);
}
