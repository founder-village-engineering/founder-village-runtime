import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type pg from "pg";
import { authRoutes } from "../services/admin-api/auth.ts";
import { consumeApproval } from "../services/admin-api/stepup.ts";
import { fingerprint } from "../packages/operations/cloudflare.ts";

const expected = {
  id: "936489dc-56fd-4cc0-868c-e503f36cb378",
  actor: "https://synthetic.invalid|admin",
  environment: "local" as const,
  action: "backup.verify",
  parameters: {},
};
const administrator = {
  ...expected,
  enabled: true,
  actions: ["backup.verify"],
  applications: ["founder-village"],
};
function proof(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    actor: expected.actor,
    subject: "admin",
    claims: {
      iat: now,
      auth_time: now,
      nonce: fingerprint(expected),
      ...claims,
    },
  };
}
function database(row: typeof administrator | undefined, auditFails = false) {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.startsWith("SELECT o.id")) return { rows: row ? [row] : [] };
      if (auditFails && sql.startsWith("SELECT control.append_audit"))
        throw new Error("synthetic audit failure");
      return { rows: [], rowCount: 1 };
    },
    release() {
      queries.push("RELEASE");
    },
  };
  return {
    queries,
    pool: { connect: async () => client } as unknown as pg.Pool,
  };
}
function localEnvironment(t: { after(fn: () => void): void }) {
  const old = process.env.FV_ENV;
  process.env.FV_ENV = "local";
  t.after(() => {
    if (old === undefined) delete process.env.FV_ENV;
    else process.env.FV_ENV = old;
  });
}

test("auth status validates durable session instead of trusting a cookie and disables caching", async (t) => {
  localEnvironment(t);
  let valid = false;
  const db = {
    async query() {
      return { rows: valid ? [{ actor: "synthetic", actions: [] }] : [] };
    },
  } as unknown as pg.Pool;
  const app = Fastify();
  await authRoutes(app, db);
  t.after(() => app.close());
  for (const state of [false, true, false]) {
    valid = state;
    const result = await app.inject({
      url: "/auth/status",
      headers: { cookie: "fv_session=synthetic" },
    });
    assert.equal(result.json().authenticated, state);
    assert.equal(result.headers["cache-control"], "no-store");
  }
  const missing = await app.inject({ url: "/auth/status" });
  assert.equal(missing.json().authenticated, false);
  const denied = await app.inject({ url: "/auth/callback" });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.headers["cache-control"], "no-store");
});

test("operation approval locks current grants and commits its audit with the state change", async (t) => {
  localEnvironment(t);
  const { pool, queries } = database(administrator);
  await consumeApproval(pool, expected.id, proof(), "synthetic-proof");
  assert.equal(queries[0], "BEGIN");
  assert(queries[1]?.includes("FOR UPDATE OF o FOR SHARE OF a"));
  assert(queries[2]?.startsWith("UPDATE control.operations"));
  assert(queries[3]?.startsWith("SELECT control.append_audit"));
  assert.deepEqual(queries.slice(-2), ["COMMIT", "RELEASE"]);
});

test("approval audit failure rolls back authorization; revoked action and replay cannot queue", async (t) => {
  localEnvironment(t);
  for (const [row, fail] of [
    [administrator, true],
    [{ ...administrator, actions: [] }, false],
    [{ ...administrator, enabled: false }, false],
    [undefined, false],
  ] as [typeof administrator | undefined, boolean][]) {
    const { pool, queries } = database(row, fail);
    await assert.rejects(
      consumeApproval(pool, expected.id, proof(), "synthetic"),
    );
    assert.deepEqual(queries.slice(-2), ["ROLLBACK", "RELEASE"]);
    assert(!queries.includes("COMMIT"));
  }
});

test("approval rejects old, missing, nonfinite, future and mismatched claims before queueing", async (t) => {
  localEnvironment(t);
  for (const claims of [
    { iat: Date.now() / 1000 - 301 },
    { auth_time: undefined },
    { auth_time: Infinity },
    { auth_time: Date.now() / 1000 + 30 },
    { nonce: "other-operation" },
  ]) {
    const { pool, queries } = database(administrator);
    await assert.rejects(
      consumeApproval(pool, expected.id, proof(claims), "synthetic"),
    );
    assert(!queries.some((sql) => sql.startsWith("UPDATE")));
  }
});
