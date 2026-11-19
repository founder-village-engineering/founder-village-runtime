import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { localAdminLink } from "./admin-login.ts";
import { hash, local, randomToken } from "../packages/auth/index.ts";
import { pool, secret } from "../packages/database/index.ts";
import { applications } from "../packages/database/applications.ts";

// Deliberately local and bounded. Never scan provider or production endpoints,
// alter owner grants, enqueue privileged operations, or write application data.
if (!local() || secret("ADMIN_ORIGIN") !== "https://admin.fv")
  throw new Error("This exercise requires the canonical local admin stack");
const origin = "https://admin.fv";
type Credentials = { cookie: string; csrf: string; token: string };
const db = pool("CONTROL_MIGRATION_DATABASE_URL");
const codes = new Set<string>();
const sessions = new Set<string>();
const actor = `https://local.fv|red-blue-${randomUUID()}`;
const results: { attack: string; passed: boolean; status?: number }[] = [];
let cleanupCompleted = false;

async function request(
  path: string,
  body?: unknown,
  credentials?: Credentials,
  override: Record<string, string> = {},
) {
  return fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined
        ? {}
        : { origin, "content-type": "application/json" }),
      ...(credentials
        ? { cookie: credentials.cookie, "x-csrf-token": credentials.csrf }
        : {}),
      ...override,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
}
async function check(
  attack: string,
  action: () => Promise<Response | void>,
  status?: number,
) {
  const result: (typeof results)[number] = { attack, passed: false };
  results.push(result);
  const response = await action();
  if (response) {
    result.status = response.status;
    if (status !== undefined) assert.equal(response.status, status, attack);
    assert.equal(response.headers.get("cache-control"), "no-store", attack);
    await response.body?.cancel();
  }
  result.passed = true;
  console.log(`PASS ${attack}`);
}
async function issue() {
  const url = new URL(await localAdminLink());
  const code = new URLSearchParams(url.hash.slice(1)).get("admin-login")!;
  codes.add(hash(code));
  return code;
}
function credentials(response: Response): Credentials {
  const set = response.headers.getSetCookie();
  const token = /^fv_session=([^;]+)/.exec(
    set.find((value) => value.startsWith("fv_session=")) ?? "",
  )?.[1];
  const csrf = /^fv_csrf=([^;]+)/.exec(
    set.find((value) => value.startsWith("fv_csrf=")) ?? "",
  )?.[1];
  assert(token && csrf, "opaque session and CSRF cookies required");
  sessions.add(hash(token));
  for (const cookie of set) {
    assert.match(cookie, /; Secure(?:;|$)/i);
    assert.match(cookie, /; SameSite=Strict(?:;|$)/i);
    assert(!/; Domain=/i.test(cookie), "cookies must remain host-only");
  }
  assert.match(
    set.find((value) => value.startsWith("fv_session="))!,
    /; HttpOnly/i,
  );
  return { token, csrf, cookie: `fv_session=${token}; fv_csrf=${csrf}` };
}

try {
  const status = await request("/auth/status");
  const mode = (await status.json()) as {
    local: boolean;
    fixtureLogin: boolean;
  };
  assert(
    mode.local && !mode.fixtureLogin,
    "exercise must use real local credentials",
  );
  await check(
    "anonymous console with spoofed administrator headers",
    () =>
      request("/hasura/console", undefined, undefined, {
        "x-hasura-admin-secret": "synthetic-attacker",
        "x-admin": "root",
      }),
    401,
  );
  await check(
    "credential-free local login",
    () => request("/auth/local", {}),
    401,
  );
  await check("background worker cannot mint administrator codes", async () => {
    const runner = pool("RUNNER_DATABASE_URL");
    try {
      await assert.rejects(
        runner.query(
          "INSERT INTO control.local_admin_codes(token_hash,actor,expires_at) SELECT $1,$2,now() WHERE false",
          [hash(randomToken()), JSON.parse(secret("ROOT_ADMIN_ACTORS"))[0]],
        ),
        { code: "42501" },
      );
    } finally {
      await runner.end();
    }
  });
  const code = await issue();
  const login = await request("/auth/local", { code });
  assert.equal(login.status, 200, "fresh one-time code must sign in");
  const root = credentials(login);
  await login.body?.cancel();
  await check(
    "one-time code replay",
    () => request("/auth/local", { code }),
    401,
  );
  await check(
    "expired one-time code",
    async () => {
      const expired = await issue();
      await db.query(
        "UPDATE control.local_admin_codes SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
        [hash(expired)],
      );
      return request("/auth/local", { code: expired });
    },
    401,
  );
  await check("concurrent one-time code redemption", async () => {
    const once = await issue();
    const responses = await Promise.all([
      request("/auth/local", { code: once }),
      request("/auth/local", { code: once }),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 401]);
    credentials(responses.find((r) => r.status === 200)!);
    await Promise.all(responses.map((r) => r.body?.cancel()));
  });
  await check("console credential leakage and cache policy", async () => {
    const response = await request(
      "/hasura/console/data/manage/source/founder-village",
      undefined,
      root,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(
      response.headers.get("content-security-policy")!,
      /frame-ancestors 'self'/,
    );
    assert(!(await response.text()).includes(secret("HASURA_ADMIN_SECRET")));
  });
  const metadata = { type: "export_metadata", args: {} };
  for (const [name, headers] of [
    ["missing CSRF token", { "x-csrf-token": "" }],
    ["wrong CSRF token", { "x-csrf-token": "synthetic-wrong" }],
    ["sibling-origin CSRF", { origin: "https://api.fv" }],
    ["cross-site fetch", { "sec-fetch-site": "cross-site" }],
  ] as const)
    await check(
      name,
      () => request("/hasura/v1/metadata", metadata, root, headers),
      403,
    );
  await check(
    "metadata writes",
    () =>
      request(
        "/hasura/v1/metadata",
        { type: "clear_metadata", args: {} },
        root,
      ),
    403,
  );
  await check(
    "write smuggled in read bulk",
    () =>
      request(
        "/hasura/v1/metadata",
        {
          type: "bulk",
          args: [metadata, { type: "clear_metadata", args: {} }],
        },
        root,
      ),
    403,
  );
  await check(
    "unknown database source",
    () =>
      request(
        "/hasura/v2/query",
        { type: "run_sql", args: { source: "fv_control", sql: "SELECT 1" } },
        root,
      ),
    400,
  );
  for (const [name, query] of [
    ["GraphQL mutation", "mutation { __typename }"],
    [
      "GraphQL hidden mutation",
      "query Safe { __typename } mutation Hidden { __typename }",
    ],
    ["GraphQL subscription", "subscription { __typename }"],
  ])
    await check(
      name!,
      () => request("/hasura/v1/graphql", { query }, root),
      403,
    );
  await check(
    "double-encoded path traversal",
    () =>
      request(
        "/hasura/console/assets/versioned/%252e%252e/private",
        undefined,
        root,
      ),
    400,
  );
  await check(
    "all four private metadata sources remain available",
    async () => {
      const response = await request("/hasura/v1/metadata", metadata, root);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert(!text.includes(secret("HASURA_ADMIN_SECRET")));
      const payload = JSON.parse(text) as { sources: { name: string }[] };
      assert.deepEqual(
        payload.sources.map((s) => s.name).sort(),
        applications.map((a) => a.hasuraSource).sort(),
      );
    },
  );
  await check(
    "legitimate SQL inspection",
    () =>
      request(
        "/hasura/v2/query",
        {
          type: "run_sql",
          args: {
            source: "founder-village",
            sql: "SELECT 1 AS inspection",
            read_only: false,
          },
        },
        root,
      ),
    200,
  );
  for (const [name, sql] of [
    [
      "SQL write with read_only disabled",
      "UPDATE app.records SET content=content WHERE false",
    ],
    [
      "SQL transaction escape",
      "COMMIT; BEGIN READ WRITE; UPDATE app.records SET content=content WHERE false; ROLLBACK",
    ],
    [
      "SQL write hidden in CTE",
      "WITH changed AS (UPDATE app.records SET content=content WHERE false RETURNING id) SELECT * FROM changed",
    ],
    [
      "SQL write hidden in EXPLAIN",
      "EXPLAIN ANALYZE UPDATE app.records SET content=content WHERE false",
    ],
    [
      "SQL configuration escape",
      "SELECT pg_catalog.set_config('transaction_read_only','off',true)",
    ],
    ["SQL session lock abuse", "SELECT pg_advisory_lock(1)"],
    ["SQL sleep abuse", "SELECT pg_sleep(1000)"],
  ])
    await check(name!, async () => {
      const response = await request(
        "/hasura/v2/query",
        {
          type: "run_sql",
          args: { source: "founder-village", sql, read_only: false },
        },
        root,
      );
      assert.equal(
        response.status,
        403,
        "unsafe SQL must fail before forwarding",
      );
      return response;
    });
  await check(
    "SQL literals cannot confuse the syntax guard",
    () =>
      request(
        "/hasura/v2/query",
        {
          type: "run_sql",
          args: {
            source: "founder-village",
            sql: "SELECT $$COMMIT; UPDATE fake;$$ AS harmless; EXPLAIN SELECT 1",
          },
        },
        root,
      ),
    200,
  );
  await check(
    "GraphQL read remains available",
    () =>
      request("/hasura/v1/graphql", { query: "query { __typename }" }, root),
    200,
  );
  const delegatedToken = randomToken(),
    delegatedCsrf = randomToken();
  sessions.add(hash(delegatedToken));
  await db.query(
    "INSERT INTO control.administrators(actor,actions,applications) VALUES($1,$2,$3)",
    [actor, ["dashboard.read", "admins.manage"], applications.map((a) => a.id)],
  );
  await db.query(
    "INSERT INTO control.sessions(token_hash,actor,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",
    [hash(delegatedToken), actor, hash(delegatedCsrf)],
  );
  const delegated = {
    token: delegatedToken,
    csrf: delegatedCsrf,
    cookie: `fv_session=${delegatedToken}; fv_csrf=${delegatedCsrf}`,
  };
  await check(
    "delegated administrator cannot inspect cluster Hasura",
    () => request("/hasura/console", undefined, delegated),
    403,
  );
  await check(
    "expired session",
    async () => {
      await db.query(
        "UPDATE control.sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
        [hash(delegatedToken)],
      );
      return request("/hasura/console", undefined, delegated);
    },
    401,
  );
  await check(
    "logout revokes current session",
    () => request("/auth/logout", {}, root),
    200,
  );
  await check(
    "revoked session cannot load console assets",
    () => request("/hasura/console/assets/versioned/main.js", undefined, root),
    401,
  );
  for (const hostname of ["hasura.fv", "hasura-dev.fv", "dev.api.fv"])
    await check(`private or nested DNS name ${hostname}`, async () => {
      await assert.rejects(
        lookup(hostname),
        (error: unknown) =>
          (error as NodeJS.ErrnoException).code === "ENOTFOUND",
      );
    });
} finally {
  try {
    await db.query(
      "DELETE FROM control.sessions WHERE token_hash=ANY($1::text[])",
      [[...sessions]],
    );
    await db.query(
      "DELETE FROM control.local_admin_codes WHERE token_hash=ANY($1::text[])",
      [[...codes]],
    );
    await db.query("DELETE FROM control.administrators WHERE actor=$1", [
      actor,
    ]);
    cleanupCompleted = true;
  } finally {
    await db.end();
    await mkdir(".state/evidence", { recursive: true });
    await writeFile(
      ".state/evidence/admin-red-blue.json",
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          scope:
            "canonical local HTTPS, real control database and private Hasura",
          passed:
            cleanupCompleted &&
            results.length > 0 &&
            results.every((r) => r.passed),
          cleanupCompleted,
          providerMfaExercised: false,
          deployedEnvironmentExercised: false,
          results,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  }
}
