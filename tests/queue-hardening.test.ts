import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { processJob, retry } from "../packages/queue/index.ts";

const message = {
  version: 1,
  application: "founder-village",
  jobId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  correlationId: "33333333-3333-4333-8333-333333333333",
  actor: "issuer|member",
};
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const row = {
    state: "published",
    tenant_id: message.tenantId,
    actor: message.actor,
    correlation_id: message.correlationId,
    record_id: "44444444-4444-4444-8444-444444444444",
    kind: "record.process",
    ...overrides,
  };
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT * FROM app.outbox"))
        return { rows: [row], rowCount: 1 };
      if (sql.includes("app.is_member"))
        return { rows: [{ allowed: true }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const db = {
    ...client,
    async connect() {
      return client;
    },
  } as unknown as pg.Pool;
  return { db, calls };
}

test("forged application and actor deliveries cannot write effect or retry state", async () => {
  const { db, calls } = fixture();
  await assert.rejects(
    processJob(db, { ...message, application: "founder-cafe" }),
  );
  await assert.rejects(retry(db, { ...message, application: "founder-cafe" }));
  assert.equal(calls.length, 0);
  await assert.rejects(processJob(db, { ...message, actor: "attacker" }));
  assert(!calls.some(({ sql }) => /^(INSERT|UPDATE)/.test(sql)));
});

test("stale deliveries cannot execute delayed or terminal jobs", async () => {
  for (const state of ["pending", "dead", "completed"]) {
    const { db, calls } = fixture({ state });
    await processJob(db, message);
    assert(!calls.some(({ sql }) => /^(INSERT|UPDATE)/.test(sql)), state);
  }
});

test("unknown job kinds roll back before recording an effect", async () => {
  const { db, calls } = fixture({ kind: "arbitrary.operation" });
  await assert.rejects(processJob(db, message));
  assert(calls.some(({ sql }) => sql === "ROLLBACK"));
  assert(!calls.some(({ sql }) => /^(INSERT|UPDATE)/.test(sql)));
});

test("authentic record processing retains membership and durable effect checks", async () => {
  const { db, calls } = fixture();
  await processJob(db, message);
  assert(calls.some(({ sql }) => sql.includes("INSERT INTO app.job_effects")));
  assert(calls.some(({ sql }) => sql.includes("app.is_member")));
  assert(calls.some(({ sql }) => sql.includes("UPDATE app.records")));
  assert.equal(calls.at(-1)?.sql, "COMMIT");
});

test("retry updates require all provenance fields and published state atomically", async () => {
  const { db, calls } = fixture();
  await retry(db, message);
  const update = calls[0]!;
  assert.deepEqual(update.values, [
    message.jobId,
    message.tenantId,
    message.actor,
    message.correlationId,
  ]);
  assert(
    update.sql.includes(
      "tenant_id=$2 AND actor=$3 AND correlation_id=$4 AND state='published'",
    ),
  );
  assert(update.sql.includes("WHEN attempts>=4 THEN 'dead'"));
});
