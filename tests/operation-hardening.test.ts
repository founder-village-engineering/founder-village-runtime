import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import {
  authorizeOperation,
  type Assertion,
} from "../packages/operations/authorize.ts";
import { applications } from "../packages/database/applications.ts";
import { scopedServiceEnvironments } from "../scripts/materialize-service-env.ts";

const expected: Assertion = {
  id: "11111111-1111-4111-8111-111111111111",
  actor: "synthetic-owner",
  environment: "local",
  action: "backup.verify",
  parameters: {},
};
function database(scopes: string[], request = expected) {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.startsWith("SELECT o.id"))
        return {
          rows: [
            {
              ...request,
              enabled: true,
              actions: [request.action],
              applications: scopes,
            },
          ],
          rowCount: 1,
        };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return {
    db: {
      async connect() {
        return client;
      },
    } as unknown as pg.Pool,
    statements,
  };
}

test("runner independently rejects cluster operations after application scope revocation", async (t) => {
  const old = process.env.FV_ENV;
  process.env.FV_ENV = "local";
  t.after(() => {
    if (old === undefined) delete process.env.FV_ENV;
    else process.env.FV_ENV = old;
  });
  const limited = database(["founder-village"]);
  await assert.rejects(() => authorizeOperation(limited.db, expected), {
    statusCode: 403,
  });
  assert(limited.statements.includes("ROLLBACK"));
  assert(
    !limited.statements.some((sql) =>
      sql.startsWith("INSERT INTO control.operation_authorizations"),
    ),
  );
  const full = database(applications.map((a) => a.id));
  await authorizeOperation(full.db, expected);
  assert(full.statements.includes("COMMIT"));
  assert(full.statements.some((sql) => sql.includes("FOR SHARE OF o")));
});

test("runner rejects unknown catalog actions, injected parameters and unregistered namespaces", async (t) => {
  const old = process.env.FV_ENV;
  process.env.FV_ENV = "local";
  t.after(() => {
    if (old === undefined) delete process.env.FV_ENV;
    else process.env.FV_ENV = old;
  });
  for (const request of [
    { ...expected, action: "shell" },
    { ...expected, parameters: { command: "reboot" } },
    {
      ...expected,
      action: "jobs.retry",
      parameters: { application: "unregistered", jobId: expected.id },
    },
  ]) {
    const fixture = database(
      ["unregistered", ...applications.map((a) => a.id)],
      request,
    );
    await assert.rejects(() => authorizeOperation(fixture.db, request));
    assert(
      !fixture.statements.some((sql) =>
        sql.startsWith("INSERT INTO control.operation_authorizations"),
      ),
    );
  }
});

test("domain worker receives verification configuration without provider-wide credentials", () => {
  const values = {
    FV_ENV: "production",
    OIDC_ISSUER: "https://identity.example",
    OIDC_AUDIENCE: "api",
    OIDC_CLIENT_ID: "admin",
    OIDC_JWKS_URL: "https://identity.example/keys",
    ROOT_ADMIN_ACTORS: '["synthetic"]',
    RUNNER_DATABASE_URL: "synthetic-runner",
    POSTGRES_PASSWORD: "synthetic-root",
    HCLOUD_TOKEN: "synthetic-provider",
    FV_HCLOUD_TOKEN: crypto.randomUUID(),
    LOCAL_JWT_SECRET: "synthetic-local",
    MONITOR_TOKEN: "synthetic-monitor",
  };
  const result = scopedServiceEnvironments(values);
  for (const key of [
    "OIDC_ISSUER",
    "OIDC_AUDIENCE",
    "OIDC_CLIENT_ID",
    "OIDC_JWKS_URL",
  ])
    assert(result.domain!.includes(`${key}=`));
  for (const key of [
    "POSTGRES_PASSWORD",
    "HCLOUD_TOKEN",
    "FV_HCLOUD_TOKEN",
    "LOCAL_JWT_SECRET",
  ])
    assert(!result.domain!.includes(`${key}=`));
  assert(!result.monitor!.includes("OIDC_"));
  assert(!result.monitor!.includes("RUNNER_DATABASE_URL"));
});
