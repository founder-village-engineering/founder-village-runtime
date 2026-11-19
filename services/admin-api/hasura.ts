import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse, Kind } from "graphql";
import { z } from "zod";
import { applications } from "../../packages/database/applications.ts";
import { audit, secret } from "../../packages/database/index.ts";
import { denied } from "../../packages/auth/index.ts";
import { boundedJson } from "../../packages/observability/http.ts";
import { authenticate } from "./auth.ts";
import { readOnlySql } from "./read-only-sql.ts";

type Principal = { actor: string; actions: string[]; applications: string[] };
export function canViewHasura(who: Principal): boolean {
  try {
    const roots = z
      .array(z.string())
      .parse(JSON.parse(process.env.ROOT_ADMIN_ACTORS ?? "[]"));
    return (
      roots.includes(who.actor) &&
      who.actions.includes("admins.manage") &&
      applications.every((a) => who.applications.includes(a.id))
    );
  } catch {
    return false;
  }
}

const readMetadata = new Set([
  "export_metadata",
  "get_inconsistent_metadata",
  "get_catalog_state",
  "list_source_kinds",
  "get_source_kind_capabilities",
  "pg_get_source_tables",
  "pg_get_source_table_info",
  "pg_suggest_relationships",
]);
const sources = new Set(applications.map((a) => a.hasuraSource));
const source = z
  .string()
  .refine((value) => sources.has(value), "unknown Hasura source");
const envelope = z
  .object({
    type: z.string(),
    args: z.unknown(),
    version: z.number().int().optional(),
    resource_version: z.number().int().optional(),
  })
  .strict();

export function readOnlyHasura(input: unknown, depth = 0): unknown {
  if (depth > 4) denied(403);
  const body = envelope.parse(input);
  if (body.type === "bulk" || body.type === "concurrent_bulk") {
    const args = z.array(z.unknown()).max(20).parse(body.args);
    return {
      ...body,
      args: args.map((item) => readOnlyHasura(item, depth + 1)),
    };
  }
  if (body.type === "run_sql" || body.type === "pg_run_sql") {
    const args = z
      .object({
        source,
        sql: z
          .string()
          .min(1)
          .max(48 * 1024),
      })
      .passthrough()
      .parse(body.args);
    readOnlySql(args.sql);
    return {
      ...body,
      args: {
        source: args.source,
        sql: args.sql,
        read_only: true,
        cascade: false,
        check_metadata_consistency: false,
      },
    };
  }
  if (!readMetadata.has(body.type)) denied(403);
  const args = z.record(z.string(), z.unknown()).parse(body.args);
  if (body.type.startsWith("pg_") || args.source !== undefined)
    source.parse(args.source);
  return body;
}

function readOnlyGraphql(input: unknown): unknown {
  const body = z
    .object({
      query: z
        .string()
        .min(1)
        .max(48 * 1024),
      variables: z.record(z.string(), z.unknown()).nullish(),
      operationName: z.string().nullish(),
    })
    .strict()
    .parse(input);
  try {
    const document = parse(body.query, { maxTokens: 2048 });
    if (
      !document.definitions.some((d) => d.kind === Kind.OPERATION_DEFINITION) ||
      document.definitions.some(
        (d) => d.kind === Kind.OPERATION_DEFINITION && d.operation !== "query",
      )
    )
      denied(403);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 403) throw error;
    throw Object.assign(new Error("invalid GraphQL query"), {
      statusCode: 400,
    });
  }
  return body;
}

async function bytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error("empty upstream response");
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error("upstream response too large");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function hasuraRoutes(app: FastifyInstance, db: pg.Pool) {
  const principals = new WeakMap<FastifyRequest, Principal>();
  app.route({
    method: ["GET", "POST"],
    url: "/hasura/*",
    bodyLimit: 64 * 1024,
    config: { rateLimit: { max: 600, timeWindow: 60000 } },
    onRequest: async (req, reply) => {
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
      const who = await authenticate(db, req, "admins.manage");
      if (!canViewHasura(who) || req.headers["sec-fetch-site"] === "cross-site")
        denied(403);
      principals.set(req, who);
    },
    handler: async (req, reply) => {
      const who = principals.get(req)!;
      const raw = req.url.split("?", 1)[0]!.slice("/hasura".length);
      let path: string;
      try {
        path = decodeURIComponent(raw);
      } catch {
        denied(400);
      }
      if (
        path.includes("%") ||
        path.includes("\\") ||
        path.split("/").includes("..") ||
        path.includes("//")
      )
        denied(400);
      const consolePage =
        /^\/console(?:\/[a-zA-Z0-9_./~-]*)?$/.test(path) &&
        !path.startsWith("/console/assets/");
      const asset =
        /^\/console\/assets\/(common|versioned)\/[a-zA-Z0-9_./@~-]+\.(js|css|png|svg|jpg|woff2?)(\.gz)?$/.test(
          path,
        );
      const getApi = [
        "/v1/version",
        "/v1alpha1/config",
        "/v1/entitlement",
        "/healthz",
      ].includes(path);
      const postApi = [
        "/v1/metadata",
        "/v1/query",
        "/v2/query",
        "/v1/graphql",
      ].includes(path);
      if (path === "/bridge.js" && req.method === "GET") {
        return reply
          .type("text/javascript")
          .send(await readFile("dist/services/admin-api/hasura-bridge.js"));
      }
      if (!(req.method === "GET" ? consolePage || asset || getApi : postApi))
        denied(404);
      let body: unknown;
      if (req.method === "POST")
        body =
          path === "/v1/graphql"
            ? readOnlyGraphql(req.body)
            : readOnlyHasura(req.body);
      if (!asset)
        await audit(db, who.actor, "hasura.read", path, "requested", req.id);
      const target = new URL(secret("HASURA_URL"));
      if (
        target.search ||
        target.hash ||
        target.username ||
        target.password ||
        target.pathname !== "/"
      )
        throw new Error("invalid private Hasura origin");
      target.pathname = path;
      const upstream = await fetch(target, {
        method: req.method,
        redirect: "error",
        signal: AbortSignal.timeout(asset ? 30000 : 10000),
        headers: {
          "x-hasura-admin-secret": secret("HASURA_ADMIN_SECRET"),
          "content-type": "application/json",
          "accept-encoding": "identity",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).catch(() => {
        throw Object.assign(new Error("private Hasura unavailable"), {
          statusCode: 502,
        });
      });
      if (consolePage && upstream.ok) {
        let html = (await bytes(upstream, 512 * 1024)).toString("utf8");
        if (!html.includes('<script type="module">'))
          throw new Error("unsupported Hasura console template");
        const nonce = randomBytes(24).toString("base64");
        html = html
          .replace(
            '<script type="module">',
            '<script type="module">\nimport "/hasura/bridge.js";\n',
          )
          .replace(/<script\b/g, `<script nonce="${nonce}"`);
        reply
          .header("x-frame-options", "SAMEORIGIN")
          .header(
            "content-security-policy",
            `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; object-src 'none'`,
          );
        return reply.type("text/html").send(html);
      }
      if (asset)
        return reply
          .code(upstream.status)
          .type(
            upstream.headers.get("content-type") ?? "application/octet-stream",
          )
          .send(await bytes(upstream, 20 * 1024 * 1024));
      const payload = await boundedJson(upstream, 4 * 1024 * 1024);
      if (
        !upstream.ok &&
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload)
      )
        delete (payload as Record<string, unknown>).internal;
      return reply.code(upstream.status).send(payload);
    },
  });
}
