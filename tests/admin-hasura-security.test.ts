import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type pg from "pg";
import { admin } from "../services/admin-api/app.ts";
import { hash } from "../packages/auth/index.ts";
import { applications } from "../packages/database/applications.ts";

async function fixture(t: { after(fn: () => unknown): void }) {
  const saved = Object.fromEntries(
    [
      "FV_ENV",
      "ADMIN_ORIGIN",
      "ROOT_ADMIN_ACTORS",
      "HASURA_URL",
      "HASURA_ADMIN_SECRET",
    ].map((key) => [key, process.env[key]]),
  );
  const calls: {
    path: string;
    headers: Record<string, unknown>;
    body: Record<string, unknown>;
  }[] = [];
  let redirect = false;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    calls.push({
      path: req.url!,
      headers: req.headers,
      body: text ? JSON.parse(text) : {},
    });
    if (redirect) {
      res.writeHead(302, { location: "http://127.0.0.1:1/private" });
      res.end();
      return;
    }
    if (req.url!.startsWith("/console")) {
      res.setHeader("content-type", "text/html");
      res.end(
        '<html><head><script>window.__env={isAdminSecretSet:true}</script></head><body><script type="module">void 0;</script></body></html>',
      );
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
    }
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address() as { port: number };
  Object.assign(process.env, {
    FV_ENV: "local",
    ADMIN_ORIGIN: "https://admin.fv",
    ROOT_ADMIN_ACTORS: '["root"]',
    HASURA_URL: `http://127.0.0.1:${address.port}`,
    HASURA_ADMIN_SECRET: "synthetic-private-hasura-secret",
  });
  const session = {
    actor: "root",
    actions: ["dashboard.read", "admins.manage"],
    applications: applications.map((a) => a.id),
    csrf_hash: hash("csrf"),
  };
  let enabled = true;
  const db = {
    query: async (sql: string, params?: unknown[]) =>
      sql.includes("FROM control.sessions")
        ? { rows: enabled && params?.[0] === hash("session") ? [session] : [] }
        : { rows: [], rowCount: 1 },
  } as unknown as pg.Pool;
  const app = await admin(db);
  t.after(async () => {
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const headers = {
    cookie: "fv_session=session",
    origin: "https://admin.fv",
    "x-csrf-token": "csrf",
    "content-type": "application/json",
  };
  return {
    app,
    calls,
    session,
    headers,
    revoke: () => {
      enabled = false;
    },
    redirect: () => {
      redirect = true;
    },
  };
}

test("red/blue: anonymous, delegated, scope-reduced and revoked sessions cannot reach Hasura", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.app.inject({
        url: "/hasura/console",
        headers: { "x-admin": "root", "x-hasura-admin-secret": "spoofed" },
      })
    ).statusCode,
    401,
  );
  f.session.actor = "delegated";
  assert.equal(
    (await f.app.inject({ url: "/hasura/console", headers: f.headers }))
      .statusCode,
    403,
  );
  f.session.actor = "root";
  f.session.applications = [applications[0]!.id];
  assert.equal(
    (await f.app.inject({ url: "/hasura/console", headers: f.headers }))
      .statusCode,
    403,
  );
  f.session.applications = applications.map((a) => a.id);
  assert.equal(
    (await f.app.inject({ url: "/hasura/console", headers: f.headers }))
      .statusCode,
    200,
  );
  const count = f.calls.length;
  f.revoke();
  assert.equal(
    (
      await f.app.inject({
        url: "/hasura/console/assets/versioned/main.js",
        headers: f.headers,
      })
    ).statusCode,
    401,
  );
  assert.equal(f.calls.length, count);
});

test("red/blue: cross-site requests, traversal, metadata writes, GraphQL mutations and unknown sources are blocked before forwarding", async (t) => {
  const f = await fixture(t);
  const read = { type: "export_metadata", args: {} };
  for (const headers of [
    { ...f.headers, origin: "https://api.fv" },
    { ...f.headers, "x-csrf-token": "wrong" },
    { ...f.headers, "sec-fetch-site": "cross-site" },
  ])
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/hasura/v1/metadata",
          headers,
          payload: read,
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await f.app.inject({
        url: "/hasura/console/assets/versioned/%252e%252e/private",
        headers: f.headers,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await f.app.inject({ url: "/hasura/v1/metadata", headers: f.headers }))
      .statusCode,
    404,
  );
  for (const payload of [
    { type: "replace_metadata", args: {} },
    { type: "bulk", args: [read, { type: "clear_metadata", args: {} }] },
  ])
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/hasura/v1/metadata",
          headers: f.headers,
          payload,
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/hasura/v2/query",
        headers: f.headers,
        payload: {
          type: "run_sql",
          args: { source: "fv_control", sql: "SELECT 1" },
        },
      })
    ).statusCode,
    400,
  );
  for (const query of [
    "mutation X { alias: delete_app_records(where: {}) { affected_rows } }",
    "query Safe { __typename } mutation Hidden { __typename }",
    "subscription { __typename }",
  ])
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/hasura/v1/graphql",
          headers: f.headers,
          payload: { query },
        })
      ).statusCode,
      403,
    );
  for (const sql of [
    "COMMIT; BEGIN READ WRITE; UPDATE app.records SET content=content WHERE false",
    "WITH x AS (DELETE FROM app.records WHERE false RETURNING *) SELECT * FROM x",
    "EXPLAIN ANALYZE DELETE FROM app.records WHERE false",
    "SELECT * INTO TEMP pretend FROM app.records",
    "SELECT pg_catalog.set_config('transaction_read_only','off',true)",
    "SELECT pg_catalog.\"set_config\"('statement_timeout','0',true)",
    "SELECT pg_advisory_lock(1)",
    "SELECT pg_sleep(1000)",
    "SELECT * FROM app.records FOR UPDATE",
  ])
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/hasura/v2/query",
          headers: f.headers,
          payload: {
            type: "run_sql",
            args: { source: "founder-village", sql },
          },
        })
      ).statusCode,
      403,
    );
  assert.equal(f.calls.length, 0);
});

test("blue: authenticated inspection forces read-only SQL, strips browser credentials, never caches console pages and blocks redirects", async (t) => {
  const f = await fixture(t);
  const page = await f.app.inject({
    url: "/hasura/console/data/founder-village/schema/app",
    headers: f.headers,
  });
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers.pragma, "no-cache");
  assert.match(
    String(page.headers["content-security-policy"]),
    /frame-ancestors 'self'/,
  );
  assert.match(page.body, /<script nonce="[^"]+"/);
  assert(page.body.includes('import "/hasura/bridge.js"'));
  assert(!page.body.includes(process.env.HASURA_ADMIN_SECRET!));
  const response = await f.app.inject({
    method: "POST",
    url: "/hasura/v2/query",
    headers: {
      ...f.headers,
      authorization: "Bearer attacker",
      "x-hasura-admin-secret": "attacker",
      "x-hasura-role": "admin",
    },
    payload: {
      type: "run_sql",
      args: {
        source: "founder-village",
        sql: "SELECT 1",
        read_only: false,
        cascade: true,
      },
    },
  });
  assert.equal(response.statusCode, 200);
  const call = f.calls.at(-1)!;
  assert.deepEqual(call.body.args, {
    source: "founder-village",
    sql: "SELECT 1",
    read_only: true,
    cascade: false,
    check_metadata_consistency: false,
  });
  assert.equal(
    call.headers["x-hasura-admin-secret"],
    process.env.HASURA_ADMIN_SECRET,
  );
  for (const name of [
    "cookie",
    "authorization",
    "x-hasura-role",
    "x-csrf-token",
  ])
    assert.equal(call.headers[name], undefined);
  f.redirect();
  assert.equal(
    (await f.app.inject({ url: "/hasura/v1/version", headers: f.headers }))
      .statusCode,
    502,
  );
});
