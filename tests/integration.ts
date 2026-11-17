import { authorizeOperation } from "../packages/operations/authorize.ts";
import {
  applicationPools,
  applications,
} from "../packages/database/applications.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { api } from "../services/api/app.ts";
import { admin } from "../services/admin-api/app.ts";
import { pool, tenant } from "../packages/database/index.ts";
import { localToken, local, hash } from "../packages/auth/index.ts";
import {
  broker,
  relay,
  processJob,
  retry,
  queueName,
} from "../packages/queue/index.ts";
import { migrate } from "../packages/database/migrate.ts";
if (!local()) throw new Error("Integration fixtures are local-only");
const db = pool(),
  control = pool("CONTROL_DATABASE_URL"),
  worker = pool("WORKER_DATABASE_URL"),
  migration = pool("MIGRATION_DATABASE_URL"),
  cm = pool("CONTROL_MIGRATION_DATABASE_URL");
const namespaces = applicationPools();
const app = await api(namespaces),
  consoleApp = await admin(control);
const proof: string[] = [];
const tid = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const token = await localToken("alice"),
  bob = await localToken("bob");
const headers = { authorization: `Bearer ${token}`, "x-tenant-id": tid };
try {
  await migrate(migration, "app");
  await migrate(cm, "control");
  proof.push("migrations repeat without drift");
  assert.equal((await app.inject({ url: "/records" })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        url: "/records",
        headers: {
          ...headers,
          authorization: `Bearer ${token.slice(0, -5)}xxxxx`,
        },
      })
    ).statusCode,
    401,
  );
  const key = randomUUID(),
    content = `Synthetic recovery ${randomUUID()}`;
  const payload = { content, embedding: [1, Math.random(), Math.random()] };
  const created = await app.inject({
    method: "POST",
    url: "/records",
    headers: { ...headers, "idempotency-key": key },
    payload,
  });
  assert.equal(created.statusCode, 201, created.body);
  const record = created.json() as { id: string; jobId: string };
  const repeated = await app.inject({
    method: "POST",
    url: "/records",
    headers: { ...headers, "idempotency-key": key },
    payload,
  });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().id, record.id);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/records",
        headers: { ...headers, "idempotency-key": key },
        payload: { ...payload, content: "changed" },
      })
    ).statusCode,
    409,
  );
  proof.push("authenticated persistence and idempotency conflict");
  assert.equal(
    (
      await app.inject({
        url: "/records",
        headers: { ...headers, "x-tenant-id": other },
      })
    ).statusCode,
    403,
  );
  const visible = await app.inject({
    url: "/records",
    headers: { authorization: `Bearer ${bob}`, "x-tenant-id": other },
  });
  assert.equal(visible.statusCode, 200);
  assert(!visible.body.includes(record.id));
  await tenant(db, `${process.env.OIDC_ISSUER}|alice`, tid, async (c) =>
    assert.equal(
      (await c.query("SELECT id FROM app.records WHERE tenant_id=$1", [other]))
        .rowCount,
      0,
    ),
  );
  proof.push("cross-tenant API and database RLS denial");
  const wrongUrl = new URL(process.env.FOUNDER_VILLAGE_DATABASE_URL!);
  wrongUrl.pathname = "/founder-farm";
  const wrongDatabase = new pg.Pool({ connectionString: wrongUrl.href });
  try {
    await assert.rejects(() => wrongDatabase.query("SELECT 1"), {
      code: "42501",
    });
  } finally {
    await wrongDatabase.end();
  }
  proof.push(
    "application database login cannot CONNECT to another application",
  );

  for (const namespace of applications.filter(
    (a) => a.id !== "founder-village",
  )) {
    assert.equal(
      (
        await app.inject({
          url: "/records",
          headers: { ...headers, "x-application-id": namespace.id },
        })
      ).statusCode,
      403,
    );
    const own = await localToken(namespace.id);
    const nsHeaders = {
      authorization: `Bearer ${own}`,
      "x-tenant-id": tid,
      "x-application-id": namespace.id,
    };
    const result = await app.inject({
      method: "POST",
      url: "/records",
      headers: { ...nsHeaders, "idempotency-key": randomUUID() },
      payload: {
        content: `Synthetic ${namespace.id}`,
        embedding: [0.1, 1, 0.2],
      },
    });
    assert.equal(result.statusCode, 201, result.body);
    const nsRecords = await app.inject({ url: "/records", headers: nsHeaders });
    assert(!nsRecords.body.includes(record.id));
  }
  proof.push(
    "four real application databases, application membership denial and isolated writes",
  );

  const { connection, channel } = await broker(process.env.AMQP_URL!);
  try {
    await assert.rejects(() => relay(worker, channel, "unroutable-fixture"));
    const pending = await worker.query(
      "SELECT state FROM app.outbox WHERE id=$1",
      [record.jobId],
    );
    assert.equal(pending.rows[0].state, "pending");
    proof.push("unroutable publication rolls back its outbox state");
    await relay(worker, channel);
    for (let i = 0; i < 100; i++) {
      const msg = await channel.get(queueName);
      if (!msg) break;
      await processJob(worker, JSON.parse(msg.content.toString()));
      channel.ack(msg);
    }
    const source = await worker.query("SELECT * FROM app.outbox WHERE id=$1", [
      record.jobId,
    ]);
    const row = source.rows[0];
    const envelope = {
      version: 1,
      application: "founder-village",
      jobId: row.id,
      tenantId: row.tenant_id,
      actor: row.actor,
      correlationId: row.correlation_id,
    };
    await processJob(worker, envelope);
    await processJob(worker, envelope);
    assert.equal(
      (
        await worker.query("SELECT * FROM app.job_effects WHERE job_id=$1", [
          record.jobId,
        ])
      ).rowCount,
      1,
    );
    await assert.rejects(() =>
      processJob(worker, { ...envelope, actor: "spoofed" }),
    );
    // A forged delivery must not consume retry budget, even for a known job ID.
    const retryId = randomUUID();
    await worker.query(
      "INSERT INTO app.outbox(id,tenant_id,record_id,actor,correlation_id,kind,state) VALUES($1,$2,$3,$4,$5,'record.process','published')",
      [retryId, row.tenant_id, row.record_id, row.actor, row.correlation_id],
    );
    const delivery = { ...envelope, jobId: retryId };
    try {
      await retry(worker, { ...delivery, actor: "spoofed" });
      await retry(worker, { ...delivery, correlationId: randomUUID() });
      await assert.rejects(() =>
        retry(worker, { ...delivery, application: "founder-cafe" }),
      );
      let state = await worker.query(
        "SELECT state,attempts FROM app.outbox WHERE id=$1",
        [retryId],
      );
      assert.deepEqual(state.rows[0], { state: "published", attempts: 0 });
      await retry(worker, delivery);
      await retry(worker, delivery);
      state = await worker.query(
        "SELECT state,attempts FROM app.outbox WHERE id=$1",
        [retryId],
      );
      assert.deepEqual(state.rows[0], { state: "pending", attempts: 1 });
      await processJob(worker, delivery);
      assert.equal(
        (
          await worker.query("SELECT 1 FROM app.job_effects WHERE job_id=$1", [
            retryId,
          ])
        ).rowCount,
        0,
      );
      await worker.query("UPDATE app.outbox SET state='dead' WHERE id=$1", [
        retryId,
      ]);
      await retry(worker, delivery);
      assert.equal(
        (
          await worker.query("SELECT state FROM app.outbox WHERE id=$1", [
            retryId,
          ])
        ).rows[0].state,
        "dead",
      );
    } finally {
      await migration.query("DELETE FROM app.outbox WHERE id=$1", [retryId]);
    }
    proof.push(
      "forged retries cannot mutate jobs; stale deliveries and retries preserve terminal states",
    );
  } finally {
    await connection.close();
  }
  proof.push(
    "real broker delivery, duplicate effect suppression and provenance denial",
  );
  const found = await app.inject({
    method: "POST",
    url: "/search",
    headers,
    payload: { embedding: payload.embedding, limit: 10 },
  });
  assert.equal(found.statusCode, 200);
  assert(found.body.includes(record.id));
  const gql = await app.inject({
    method: "POST",
    url: "/graphql",
    headers: {
      ...headers,
      "x-hasura-admin-secret": "spoofed",
      "x-hasura-role": "admin",
    },
    payload: { query: "{ founder_village { app_records { id content } } }" },
  });
  assert.equal(gql.statusCode, 200, gql.body);
  assert(gql.body.includes(record.id));
  assert(!gql.body.includes("Other Village"));
  proof.push("vector query and scoped real Hasura relay");
  const otherSource = await app.inject({
    method: "POST",
    url: "/graphql",
    headers,
    payload: { query: "{ founder_farm { app_records { id } } }" },
  });
  assert.equal(otherSource.statusCode, 400);
  proof.push("Hasura source role cannot query another application source");
  const origin = process.env.ADMIN_ORIGIN!;
  assert.equal(
    (
      await consoleApp.inject({
        url: "/api/dashboard",
        headers: { "x-admin": "owner" },
      })
    ).statusCode,
    401,
  );
  const login = await consoleApp.inject({
    method: "POST",
    url: "/auth/local",
    headers: { origin },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookies = login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    csrf = login.cookies.find((c) => c.name === "fv_csrf")!.value;
  const adminHeaders = {
    origin,
    cookie: cookies,
    "x-csrf-token": csrf,
    "idempotency-key": randomUUID(),
  };
  const body = { action: "backup.verify", parameters: {} };
  assert.equal(
    (
      await consoleApp.inject({
        method: "POST",
        url: "/api/operations",
        headers: { cookie: cookies, origin: "https://bad.example" },
        payload: body,
      })
    ).statusCode,
    403,
  );
  const op = await consoleApp.inject({
    method: "POST",
    url: "/api/operations",
    headers: adminHeaders,
    payload: body,
  });
  assert.equal(op.statusCode, 202, op.body);
  const op2 = await consoleApp.inject({
    method: "POST",
    url: "/api/operations",
    headers: adminHeaders,
    payload: body,
  });
  assert.equal(op2.json().id, op.json().id);
  assert.equal(
    (
      await consoleApp.inject({
        method: "POST",
        url: "/api/operations",
        headers: adminHeaders,
        payload: { action: "shell", parameters: { command: "id" } },
      })
    ).statusCode,
    400,
  );
  proof.push(
    "session auth, CSRF denial, fixed operation catalog and durable enqueue",
  );
  const runner = pool("RUNNER_DATABASE_URL");
  try {
    const id = op.json().id as string;
    await cm.query(
      "UPDATE control.operations SET state='running' WHERE id=$1",
      [id],
    );
    const expected = {
      id,
      actor: `${process.env.OIDC_ISSUER}|owner`,
      environment: "local" as const,
      action: "backup.verify",
      parameters: {},
    };
    await assert.rejects(() =>
      authorizeOperation(runner, {
        ...expected,
        parameters: { command: "forged" },
      }),
    );
    await authorizeOperation(runner, expected);
    await assert.rejects(() => authorizeOperation(runner, expected));
    await cm.query(
      "UPDATE control.operations SET state='cancelled' WHERE id=$1",
      [id],
    );
  } finally {
    await runner.end();
  }
  proof.push(
    "operation assertion tamper denial and one-time authorization consumption",
  );
  const viewer = `${process.env.OIDC_ISSUER}|synthetic-viewer`,
    session = randomUUID();
  await cm.query(
    "INSERT INTO control.administrators(actor,actions,applications) VALUES($1,ARRAY['dashboard.read','admins.manage','dns.plan','backup.verify'],ARRAY['founder-village']) ON CONFLICT(actor) DO UPDATE SET enabled=true,actions=EXCLUDED.actions,applications=EXCLUDED.applications",
    [viewer],
  );
  await cm.query(
    "INSERT INTO control.sessions(token_hash,actor,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [hash(session), viewer, hash("synthetic")],
  );
  const snapshot = await consoleApp.inject({
    url: "/api/dashboard",
    headers: { cookie: `fv_session=${session}` },
  });
  assert.equal(snapshot.statusCode, 200);
  assert.deepEqual(
    snapshot.json().applications.map((a: { id: string }) => a.id),
    ["founder-village"],
  );
  assert.deepEqual(snapshot.json().backups, []);
  assert.deepEqual(snapshot.json().peers, []);
  assert.deepEqual(snapshot.json().administrators, []);
  assert.deepEqual(snapshot.json().actions, ["dashboard.read"]);
  const viewerHeaders = {
    origin,
    cookie: `fv_session=${session}`,
    "x-csrf-token": "synthetic",
  };
  for (const request of [
    { url: "/metrics", headers: viewerHeaders },
    {
      method: "POST" as const,
      url: "/api/admins",
      headers: viewerHeaders,
      payload: {
        actor: "synthetic-escalation",
        actions: ["admins.manage"],
        enabled: true,
        applications: ["founder-farm"],
      },
    },
    {
      method: "POST" as const,
      url: "/api/dns/plan",
      headers: viewerHeaders,
      payload: { name: "blocked.example", desired: null },
    },
    {
      method: "POST" as const,
      url: `/api/operations/${op.json().id}/cancel`,
      headers: viewerHeaders,
    },
  ])
    assert.equal((await consoleApp.inject(request)).statusCode, 403);
  assert(
    snapshot.json().audit.every((a: { actor: string }) => a.actor === viewer),
  );
  await cm.query("DELETE FROM control.sessions WHERE actor=$1", [viewer]);
  await cm.query("DELETE FROM control.administrators WHERE actor=$1", [viewer]);
  proof.push(
    "delegated dashboard hides cluster inventory; grant escalation, cluster controls and cross-actor cancellation denied",
  );
  await assert.rejects(() => control.query("DELETE FROM control.audit"));
  await assert.rejects(() =>
    control.query("UPDATE control.audit SET outcome='forged'"),
  );
  proof.push("audit update and deletion denied");
  await cm.query(
    "UPDATE control.administrators SET enabled=false WHERE actor=$1",
    [`${process.env.OIDC_ISSUER}|owner`],
  );
  assert.equal(
    (
      await consoleApp.inject({
        url: "/api/dashboard",
        headers: { cookie: cookies },
      })
    ).statusCode,
    401,
  );
  await cm.query(
    "UPDATE control.administrators SET enabled=true WHERE actor=$1",
    [`${process.env.OIDC_ISSUER}|owner`],
  );
  proof.push("administrator revocation checked per request");
  const records = await app.inject({ url: "/records", headers });
  assert(records.body.includes(content.toUpperCase()));
  await mkdir(".state/evidence", { recursive: true });
  await writeFile(
    ".state/evidence/integration.json",
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        environment: "local",
        proof,
        liveProviders: false,
        recordId: record.id,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "passed", proof }, null, 2));
} finally {
  await Promise.all([app.close(), consoleApp.close()]);
  await Promise.all([
    ...Object.values(namespaces).map((p) => p.end()),
    db.end(),
    control.end(),
    worker.end(),
    migration.end(),
    cm.end(),
  ]);
}
