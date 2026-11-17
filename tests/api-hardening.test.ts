import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { api } from "../services/api/app.ts";
import { localToken } from "../packages/auth/index.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";

test("GraphQL refuses redirects and malformed upstream payloads; uploads bind content headers", async (t) => {
  const settings = {
    FV_ENV: "local",
    OIDC_ISSUER: "https://synthetic.fv.test",
    OIDC_AUDIENCE: "fv-test",
    LOCAL_JWT_SECRET: "synthetic-local-signing-key-longer-than-32-bytes",
    HASURA_JWT_SECRET: "synthetic-hasura-key-longer-than-32-bytes",
    HASURA_URL: "http://127.0.0.1:9999",
    OBJECT_ENDPOINT: "https://objects.example.test",
    OBJECT_REGION: "us-east-1",
    OBJECT_ACCESS_KEY: "synthetic-access",
    OBJECT_SECRET_KEY: "synthetic-secret",
    OBJECT_BUCKET: "synthetic-bucket",
  };
  const previous = { ...process.env },
    originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(settings)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
      if (previous[`${key}_FILE`] !== undefined)
        process.env[`${key}_FILE`] = previous[`${key}_FILE`];
    }
  });
  for (const [key, value] of Object.entries(settings)) {
    process.env[key] = value;
    delete process.env[`${key}_FILE`];
  }
  let member = true,
    requests = 0;
  const client = {
    async query(sql: string) {
      return {
        rows: sql.includes("app.is_member") ? [{ allowed: member }] : [],
        rowCount: 1,
      };
    },
    release() {},
  };
  const db = {
    ...client,
    async connect() {
      return client;
    },
  } as unknown as pg.Pool;
  const app = await api(db);
  t.after(() => app.close());
  const headers = {
    authorization: `Bearer ${await localToken("alice")}`,
    "x-tenant-id": tenantId,
  };
  let payload: unknown = { data: { records: [] } };
  let fail = false;
  globalThis.fetch = async (_url, options) => {
    requests++;
    assert.equal(options?.redirect, "error");
    if (fail) throw new Error("synthetic redirect secret diagnostic");
    return Response.json(payload);
  };
  const query = () =>
    app.inject({
      method: "POST",
      url: "/graphql",
      headers,
      payload: { query: "{ records { id } }" },
    });
  assert.equal((await query()).statusCode, 200);
  for (payload of [null, [], {}, { data: "wrong" }, { errors: [] }]) {
    const result = await query();
    assert.equal(result.statusCode, 502);
    assert.deepEqual(result.json(), { error: "graphql_unavailable" });
  }
  fail = true;
  const failed = await query();
  assert.equal(failed.statusCode, 502);
  assert(!failed.body.includes("secret diagnostic"));
  member = false;
  const before = requests;
  assert.equal((await query()).statusCode, 403);
  assert.equal(requests, before);
  member = true;
  const upload = await app.inject({
    method: "POST",
    url: "/files/upload",
    headers,
    payload: { contentType: "image/png", size: 1024 },
  });
  assert.equal(upload.statusCode, 200);
  const signed = new URL(upload.json().url);
  assert.equal(
    signed.searchParams.get("X-Amz-SignedHeaders"),
    "content-length;content-type;host",
  );
  assert(
    signed.pathname.startsWith(
      `/synthetic-bucket/founder-village/${tenantId}/`,
    ),
  );
  const excessive = await app.inject({
    method: "POST",
    url: "/files/upload",
    headers,
    payload: { contentType: "image/png", size: 10 * 1024 * 1024 + 1 },
  });
  assert.equal(excessive.statusCode, 400);
});
