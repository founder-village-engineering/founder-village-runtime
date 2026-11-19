import { publicApiDocument } from "../../packages/contracts/openapi.ts";
import { boundedJson } from "../../packages/observability/http.ts";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { SignJWT } from "jose";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { bearer, denied, hash } from "../../packages/auth/index.ts";
import { tenant, secret } from "../../packages/database/index.ts";
import {
  recordInput,
  vectorQuery,
  uuid,
} from "../../packages/contracts/index.ts";
import {
  selectApplication,
  applications,
} from "../../packages/database/applications.ts";
import { unversionedPublicApiContract } from "../../packages/contracts/api-versioning.ts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { server } from "../../packages/observability/index.ts";
import { installFrontendCors } from "./cors.ts";
import { registerFoodDeliveryRoutes } from "./food-deliveries.ts";
import {
  installApiVersionHeaders,
  registerApiVersionCatalog,
} from "./versioning.ts";
export async function api(databases: Record<string, pg.Pool> | pg.Pool) {
  const all: Record<string, pg.Pool> =
    "query" in databases
      ? { "founder-village": databases as pg.Pool }
      : databases;
  const application = (req: FastifyRequest) =>
    selectApplication(all, req.headers["x-application-id"]);
  const app = await server("api");
  installFrontendCors(app);
  app.get("/health/ready", async () => {
    await Promise.all(Object.values(all).map((db) => db.query("SELECT 1")));
    return { status: "ready" };
  });
  // Root URLs deliberately remain pinned to this registrar. A future major
  // gets a separate registrar and must not alter v1 behavior in place.
  const registerV1Routes = (routes: FastifyInstance) => {
    registerFoodDeliveryRoutes(routes, all);
    routes.get("/records", async (req) => {
      const db = application(req);
      const who = await bearer(req),
        tid = uuid.parse(req.headers["x-tenant-id"]);
      return tenant(
        db,
        who.actor,
        tid,
        async (c) =>
          (
            await c.query(
              "SELECT id,content,result,embedding_model,created_at FROM app.records ORDER BY created_at DESC LIMIT 100",
            )
          ).rows,
      );
    });
    routes.post("/records", async (req, reply) => {
      const db = application(req);
      const who = await bearer(req),
        tid = uuid.parse(req.headers["x-tenant-id"]),
        input = recordInput.parse(req.body),
        key = uuid.parse(req.headers["idempotency-key"]),
        fingerprint = hash(JSON.stringify(input));
      const result = await tenant(db, who.actor, tid, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `${tid}:${who.actor}:${key}`,
        ]);
        const previous = await c.query<{
          request_hash: string;
          record_id: string;
        }>(
          "SELECT request_hash,record_id FROM app.request_keys WHERE tenant_id=$1 AND actor=$2 AND key=$3",
          [tid, who.actor, key],
        );
        if (previous.rows[0]) {
          if (previous.rows[0].request_hash !== fingerprint)
            throw Object.assign(new Error("idempotency conflict"), {
              statusCode: 409,
            });
          return { id: previous.rows[0].record_id, replayed: true };
        }
        const id = randomUUID(),
          jobId = randomUUID();
        await c.query(
          "INSERT INTO app.records(id,tenant_id,created_by,content,embedding) VALUES($1,$2,$3,$4,$5::vector)",
          [id, tid, who.actor, input.content, JSON.stringify(input.embedding)],
        );
        await c.query(
          "INSERT INTO app.outbox(id,tenant_id,record_id,actor,correlation_id,kind) VALUES($1,$2,$3,$4,$5,'record.process')",
          [jobId, tid, id, who.actor, req.id],
        );
        await c.query(
          "INSERT INTO app.request_keys(tenant_id,actor,key,request_hash,record_id) VALUES($1,$2,$3,$4,$5)",
          [tid, who.actor, key, fingerprint, id],
        );
        return { id, jobId, replayed: false };
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    });
    routes.post("/search", async (req) => {
      const db = application(req);
      const who = await bearer(req),
        tid = uuid.parse(req.headers["x-tenant-id"]),
        input = vectorQuery.parse(req.body);
      return tenant(
        db,
        who.actor,
        tid,
        async (c) =>
          (
            await c.query(
              "SELECT id,content,result,1-(embedding <=> $1::vector) AS similarity FROM app.records WHERE tenant_id=$2 ORDER BY embedding <=> $1::vector LIMIT $3",
              [JSON.stringify(input.embedding), tid, input.limit],
            )
          ).rows,
      );
    });
    routes.post("/graphql", async (req, reply) => {
      const db = application(req);
      const who = await bearer(req),
        tid = uuid.parse(req.headers["x-tenant-id"]);
      await tenant(db, who.actor, tid, async () => {});
      const input = z
        .object({
          query: z.string().max(8000),
          variables: z.record(z.string(), z.unknown()).optional(),
          operationName: z.string().max(80).optional(),
        })
        .strict()
        .parse(req.body);
      const token = await new SignJWT({
        "https://hasura.io/jwt/claims": {
          "x-hasura-default-role": `user_${String(req.headers["x-application-id"] ?? "founder-village").replaceAll("-", "_")}`,
          "x-hasura-allowed-roles": [
            `user_${String(req.headers["x-application-id"] ?? "founder-village").replaceAll("-", "_")}`,
          ],
          "x-hasura-tenant-id": tid,
          "x-hasura-user-id": who.actor,
        },
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("1m")
        .setIssuer("fv-api")
        .setAudience("fv-hasura")
        .sign(new TextEncoder().encode(secret("HASURA_JWT_SECRET")));
      let body: { data?: unknown; errors?: unknown[] };
      try {
        const response = await fetch(`${secret("HASURA_URL")}/v1/graphql`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(8000),
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          return reply.code(502).send({ error: "graphql_unavailable" });
        }
        body = z
          .object({
            data: z.record(z.string(), z.unknown()).nullable().optional(),
            errors: z.array(z.unknown()).min(1).optional(),
          })
          .refine(
            (value) => value.data !== undefined || value.errors !== undefined,
          )
          .parse(await boundedJson(response));
      } catch {
        return reply.code(502).send({ error: "graphql_unavailable" });
      }
      return body.errors
        ? reply.code(400).send({ error: "graphql_request_failed" })
        : { data: body.data };
    });
    routes.post("/files/upload", async (req) => {
      const db = application(req);
      const who = await bearer(req),
        tid = uuid.parse(req.headers["x-tenant-id"]);
      await tenant(db, who.actor, tid, async () => {});
      const input = z
        .object({
          contentType: z.enum(["image/png", "image/jpeg", "application/pdf"]),
          size: z
            .number()
            .int()
            .positive()
            .max(10 * 1024 * 1024),
        })
        .strict()
        .parse(req.body);
      const key = `${req.headers["x-application-id"] ?? "founder-village"}/${tid}/${randomUUID()}`;
      const client = new S3Client({
        region: secret("OBJECT_REGION"),
        endpoint: secret("OBJECT_ENDPOINT"),
        forcePathStyle: true,
        credentials: {
          accessKeyId: secret("OBJECT_ACCESS_KEY"),
          secretAccessKey: secret("OBJECT_SECRET_KEY"),
        },
      });
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: secret("OBJECT_BUCKET"),
          Key: key,
          ContentType: input.contentType,
          ContentLength: input.size,
        }),
        {
          expiresIn: 300,
          signableHeaders: new Set(["content-type", "content-length"]),
        },
      );
      return { key, url, expiresIn: 300 };
    });
    routes.get("/files/:id", async (req) => {
      const db = application(req);
      const who = await bearer(req),
        tid = uuid.parse(req.headers["x-tenant-id"]);
      await tenant(db, who.actor, tid, async () => {});
      const id = uuid.parse((req.params as { id: string }).id);
      if (!id) denied();
      const client = new S3Client({
        region: secret("OBJECT_REGION"),
        endpoint: secret("OBJECT_ENDPOINT"),
        forcePathStyle: true,
        credentials: {
          accessKeyId: secret("OBJECT_ACCESS_KEY"),
          secretAccessKey: secret("OBJECT_SECRET_KEY"),
        },
      });
      return {
        url: await getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: secret("OBJECT_BUCKET"),
            Key: `${req.headers["x-application-id"] ?? "founder-village"}/${tid}/${id}`,
          }),
          { expiresIn: 60 },
        ),
      };
    });
    routes.get("/applications", async (req) => {
      await bearer(req);
      return applications.map(({ id, hasuraSource }) => ({ id, hasuraSource }));
    });
  };
  registerApiVersionCatalog(app);
  app.register(async (unversioned) => {
    installApiVersionHeaders(unversioned, unversionedPublicApiContract);
    registerV1Routes(unversioned);
    unversioned.get("/openapi.json", async () =>
      publicApiDocument(
        applications.map((a) => a.id),
        {
          contract: unversionedPublicApiContract,
          serverUrl: "/",
        },
      ),
    );
  });
  app.register(
    async (versioned) => {
      installApiVersionHeaders(versioned, unversionedPublicApiContract);
      registerV1Routes(versioned);
      versioned.get("/openapi.json", async () =>
        publicApiDocument(
          applications.map((a) => a.id),
          {
            contract: unversionedPublicApiContract,
            serverUrl: unversionedPublicApiContract.basePath,
          },
        ),
      );
    },
    { prefix: unversionedPublicApiContract.basePath },
  );
  return app;
}
