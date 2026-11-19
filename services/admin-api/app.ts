import { adminApiDocument } from "../../packages/contracts/openapi.ts";
import { applications } from "../../packages/database/applications.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { z } from "zod";
import staticFiles from "@fastify/static";
import { server, registry } from "../../packages/observability/index.ts";
import { audit, secret, transaction } from "../../packages/database/index.ts";
import { environment, hash, local } from "../../packages/auth/index.ts";
import {
  operation,
  dnsRecord,
  adminActions,
} from "../../packages/contracts/index.ts";
import {
  Cloudflare,
  fingerprint,
} from "../../packages/operations/cloudflare.ts";
import { authenticate, authRoutes, requestActor } from "./auth.ts";
import { canViewHasura, hasuraRoutes } from "./hasura.ts";
import { configuredDomains } from "./domains.ts";
const clusterScope = (grants: string[]) =>
  applications.every((a) => grants.includes(a.id));
const applicationActions = new Set([
  "dashboard.read",
  "jobs.retry",
  "schedules.manage",
]);
function requireCluster(grants: string[]) {
  if (!clusterScope(grants))
    throw Object.assign(new Error("cluster scope required"), {
      statusCode: 403,
    });
}
export async function admin(db: pg.Pool) {
  const app = await server("admin");
  await authRoutes(app, db);
  await hasuraRoutes(app, db);
  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode >= 400) {
      try {
        await audit(
          db,
          requestActor(req),
          "request.denied",
          req.routeOptions.url ?? "unmatched",
          String(reply.statusCode),
          req.id,
        );
      } catch {
        console.error(
          JSON.stringify({ event: "audit.unavailable", requestId: req.id }),
        );
      }
    }
  });
  app.get("/api/openapi", async (req) => {
    await authenticate(db, req);
    return adminApiDocument();
  });
  app.get("/health/ready", async () => {
    await db.query("SELECT 1");
    return { status: "ready" };
  });
  app.get("/api/dashboard", async (req) => {
    const who = await authenticate(db, req);
    const cluster = clusterScope(who.applications);
    const [operations, audits, backups, deployments, peers, admins] =
      await Promise.all([
        db.query(
          "SELECT id,action,state,result,actor,created_at,updated_at FROM control.operations WHERE $3::boolean OR actor=$2 OR parameters->>'application'=ANY($1::text[]) ORDER BY created_at DESC LIMIT 50",
          [who.applications, who.actor, cluster],
        ),
        db.query(
          "SELECT a.id,a.actor,a.event,a.resource,a.outcome,a.created_at,a.hash FROM control.audit a WHERE $3::boolean OR a.actor=$2 OR EXISTS(SELECT 1 FROM control.operations o WHERE o.id=a.operation_id AND o.parameters->>'application'=ANY($1::text[])) ORDER BY a.id DESC LIMIT 50",
          [who.applications, who.actor, cluster],
        ),
        db.query(
          "SELECT * FROM control.backups ORDER BY created_at DESC LIMIT 20",
        ),
        db.query(
          "SELECT * FROM control.deployments ORDER BY created_at DESC LIMIT 20",
        ),
        db.query(
          "SELECT name,address,enabled,expires_at FROM control.wireguard_peers",
        ),
        db.query(
          "SELECT actor,actions,applications,enabled FROM control.administrators",
        ),
      ]);
    await audit(db, who.actor, "dashboard.read", "control", "succeeded");
    return {
      applications: applications.filter((a) => who.applications.includes(a.id)),
      environment: environment(),
      revision: process.env.FV_REVISION ?? "local",
      actor: who.actor,
      hasura: canViewHasura(who),
      actions: who.actions.filter(
        (action) => cluster || applicationActions.has(action),
      ),
      operations: operations.rows,
      audit: audits.rows,
      backups: cluster ? backups.rows : [],
      deployments: cluster ? deployments.rows : [],
      peers: cluster ? peers.rows : [],
      administrators:
        cluster && who.actions.includes("admins.manage") ? admins.rows : [],
      domains: await configuredDomains(),
    };
  });
  app.get("/metrics", async (req, reply) => {
    const who = await authenticate(db, req);
    requireCluster(who.applications);
    return reply
      .header("content-type", registry.contentType)
      .send(await registry.metrics());
  });
  app.post("/api/operations", async (req, reply) => {
    const input = operation.parse(req.body);
    const who = await authenticate(db, req, input.action);
    if (
      !("application" in input.parameters) &&
      !applications.every((a) => who.applications.includes(a.id))
    )
      throw Object.assign(new Error("cluster scope required"), {
        statusCode: 403,
      });
    if (
      "application" in input.parameters &&
      !who.applications.includes(input.parameters.application)
    )
      throw Object.assign(new Error("application grant required"), {
        statusCode: 403,
      });
    const key = z.string().uuid().parse(req.headers["idempotency-key"]),
      id = randomUUID(),
      requestHash = hash(JSON.stringify(input));
    const row = await transaction(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${who.actor}:${key}`,
      ]);
      const previous = await c.query<{
        id: string;
        request_hash: string;
        state: string;
      }>(
        "SELECT id,request_hash,state FROM control.operations WHERE actor=$1 AND idempotency_key=$2",
        [who.actor, key],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== requestHash)
          throw Object.assign(new Error("idempotency conflict"), {
            statusCode: 409,
          });
        return previous.rows[0];
      }
      await c.query(
        "INSERT INTO control.operations(id,actor,environment,action,parameters,idempotency_key,request_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          who.actor,
          environment(),
          input.action,
          input.parameters,
          key,
          requestHash,
          local() ? "queued" : "awaiting_authorization",
        ],
      );
      await audit(c, who.actor, input.action, id, "queued", id);
      return { id, state: local() ? "queued" : "awaiting_authorization" };
    });
    return reply.code(202).send(row);
  });
  app.post("/api/operations/:id/cancel", async (req) => {
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    const found = await db.query<{
      action: string;
      actor: string;
      parameters: { application?: string };
    }>("SELECT action,actor,parameters FROM control.operations WHERE id=$1", [
      id,
    ]);
    const action = found.rows[0]?.action;
    if (!action)
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    const who = await authenticate(db, req, action);
    const target = found.rows[0]!;
    if (!target.parameters.application) requireCluster(who.applications);
    if (
      (!clusterScope(who.applications) && target.actor !== who.actor) ||
      (target.parameters.application &&
        !who.applications.includes(target.parameters.application))
    )
      throw Object.assign(new Error("operation scope denied"), {
        statusCode: 403,
      });
    await transaction(db, async (c) => {
      const result = await c.query(
        "UPDATE control.operations SET state='cancelled',updated_at=now() WHERE id=$1 AND state IN ('queued','awaiting_authorization') RETURNING id",
        [id],
      );
      if (!result.rowCount)
        throw Object.assign(new Error("already executing"), {
          statusCode: 409,
        });
      await audit(c, who.actor, action, id, "cancelled", id);
    });
    return { id, state: "cancelled" };
  });
  app.post("/api/dns/plan", async (req) => {
    const who = await authenticate(db, req, "dns.plan");
    requireCluster(who.applications);
    const input = z
      .object({ name: z.string(), desired: dnsRecord.nullable() })
      .strict()
      .parse(req.body);
    const cf = new Cloudflare();
    if (input.desired && input.desired.name !== input.name)
      throw Object.assign(new Error("name mismatch"), { statusCode: 400 });
    const before = await cf.inventory(input.name),
      id = randomUUID(),
      fp = fingerprint({ before, desired: input.desired });
    await db.query(
      "INSERT INTO control.dns_plans(id,actor,zone_id,record_name,before_state,desired,fingerprint,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')",
      [
        id,
        who.actor,
        secret("CF_ZONE_ID"),
        input.name,
        before,
        input.desired,
        fp,
      ],
    );
    await audit(db, who.actor, "dns.plan", input.name, "succeeded");
    return { id, before, desired: input.desired, fingerprint: fp };
  });
  app.post("/api/admins", async (req) => {
    const who = await authenticate(db, req, "admins.manage");
    requireCluster(who.applications);
    const input = z
      .object({
        actor: z.string().min(3).max(512),
        actions: z.array(z.enum(adminActions)).min(1),
        enabled: z.boolean(),
        applications: z
          .array(
            z.string().refine((id) => applications.some((a) => a.id === id)),
          )
          .min(1),
      })
      .strict()
      .parse(req.body);
    if (
      input.actions.some((action) => !who.actions.includes(action)) ||
      input.applications.some((id) => !who.applications.includes(id))
    )
      throw Object.assign(
        new Error("cannot grant permissions beyond your own"),
        { statusCode: 403 },
      );
    await transaction(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(51827003)");
      if (
        !input.enabled ||
        !input.actions.includes("admins.manage") ||
        !clusterScope(input.applications)
      ) {
        const { rows } = await c.query<{ count: string }>(
          "SELECT count(*)::text FROM control.administrators WHERE enabled AND 'admins.manage'=ANY(actions) AND actor<>$1 AND $2::text[] <@ applications",
          [input.actor, applications.map((a) => a.id)],
        );
        if (Number(rows[0]?.count) === 0)
          throw Object.assign(new Error("last administrator"), {
            statusCode: 409,
          });
      }
      await c.query(
        "INSERT INTO control.administrators(actor,actions,enabled,applications) VALUES($1,$2,$3,$4) ON CONFLICT(actor) DO UPDATE SET actions=$2,enabled=$3,applications=$4,updated_at=now()",
        [input.actor, input.actions, input.enabled, input.applications],
      );
      await c.query("DELETE FROM control.sessions WHERE actor=$1", [
        input.actor,
      ]);
      await audit(c, who.actor, "admins.manage", input.actor, "succeeded");
    });
    return { status: "updated" };
  });
  if (existsSync("services/admin-web/dist"))
    await app.register(staticFiles, {
      root: path.resolve("services/admin-web/dist"),
      prefix: "/",
    });
  return app;
}
