import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { admin } from "../services/admin-api/app.ts";
import { hash } from "../packages/auth/index.ts";
import { applications } from "../packages/database/applications.ts";

test("administrator updates retain a cluster administrator and cancellation checks current scope", async (t) => {
  const previous = {
    FV_ENV: process.env.FV_ENV,
    ADMIN_ORIGIN: process.env.ADMIN_ORIGIN,
  };
  process.env.FV_ENV = "local";
  process.env.ADMIN_ORIGIN = "http://127.0.0.1:43802";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const all = applications.map((a) => a.id);
  let grants = all;
  let remaining = "0";
  let writes = 0;
  const query = async (sql: string) => {
    if (sql.includes("FROM control.sessions"))
      return {
        rows: [
          {
            actor: "owner",
            actions: ["admins.manage", "backup.verify"],
            applications: grants,
            csrf_hash: hash("csrf"),
          },
        ],
        rowCount: 1,
      };
    if (sql.includes("count(*)::text"))
      return { rows: [{ count: remaining }], rowCount: 1 };
    if (sql.includes("SELECT action,actor,parameters"))
      return {
        rows: [{ actor: "owner", action: "backup.verify", parameters: {} }],
        rowCount: 1,
      };
    if (
      sql.startsWith("INSERT INTO control.administrators") ||
      sql.startsWith("UPDATE control.operations")
    )
      writes++;
    return { rows: [], rowCount: 1 };
  };
  const db = {
    query,
    connect: async () => ({ query, release() {} }),
  } as unknown as pg.Pool;
  const app = await admin(db);
  t.after(() => app.close());
  const headers = {
    cookie: "fv_session=session",
    origin: process.env.ADMIN_ORIGIN,
    "x-csrf-token": "csrf",
  };
  const update = () =>
    app.inject({
      method: "POST",
      url: "/api/admins",
      headers,
      payload: {
        actor: "owner",
        actions: ["admins.manage"],
        applications: [all[0]],
        enabled: true,
      },
    });
  assert.equal(
    (await update()).statusCode,
    409,
    "cannot remove the final cluster administrator by reducing application grants",
  );
  assert.equal(writes, 0);
  remaining = "1";
  assert.equal(
    (await update()).statusCode,
    200,
    "another cluster administrator permits scope reduction",
  );
  assert.equal(writes, 1);
  grants = [all[0]!];
  const cancel = () =>
    app.inject({
      method: "POST",
      url: "/api/operations/11111111-1111-4111-8111-111111111111/cancel",
      headers,
    });
  assert.equal(
    (await cancel()).statusCode,
    403,
    "own cluster operation still requires current cluster grants",
  );
  assert.equal(writes, 1);
  grants = all;
  assert.equal((await cancel()).statusCode, 200);
  assert.equal(writes, 2);
});
