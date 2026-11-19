import type { FastifyInstance, FastifyReply } from "fastify";
import { denied } from "../../packages/auth/index.ts";
import {
  originAllowed,
  registeredOrigin,
} from "../../packages/frontends/index.ts";

const methods = new Set(["GET", "POST", "OPTIONS"]);
const headers = new Set([
  "authorization",
  "content-type",
  "idempotency-key",
  "x-application-id",
  "x-tenant-id",
]);

function apply(reply: FastifyReply, origin: string, preflight = false) {
  reply.header("access-control-allow-origin", origin);
  reply.header(
    "access-control-expose-headers",
    "API-Version, Deprecation, Sunset, Link",
  );
  reply.header(
    "vary",
    preflight
      ? "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
      : "Origin",
  );
  if (preflight) {
    reply.header("access-control-allow-methods", [...methods].join(", "));
    reply.header("access-control-allow-headers", [...headers].join(", "));
    reply.header("access-control-max-age", "600");
  }
}

export function installFrontendCors(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin) return;
    if (request.method === "OPTIONS") {
      const requestedMethod = request.headers["access-control-request-method"];
      const requestedHeaders = String(
        request.headers["access-control-request-headers"] ?? "",
      )
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (
        !registeredOrigin(origin) ||
        typeof requestedMethod !== "string" ||
        !methods.has(requestedMethod.toUpperCase()) ||
        requestedHeaders.some((value) => !headers.has(value))
      )
        denied(403);
      apply(reply, origin, true);
      await reply.code(204).send();
      return reply;
    }
    const application = request.headers["x-application-id"];
    if (typeof application !== "string" || !originAllowed(application, origin))
      denied(403);
    apply(reply, origin);
  });
}
