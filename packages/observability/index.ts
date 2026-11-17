import { configureTracing, span, finish, flushTracing } from "./tracing.ts";
import type { Span } from "@opentelemetry/api";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { Registry, Counter, Histogram } from "prom-client";
export const registry = new Registry();
const requests = new Counter({
  name: "fv_http_requests_total",
  help: "Requests by service route and status",
  labelNames: ["service", "route", "status"],
  registers: [registry],
});
const latency = new Histogram({
  name: "fv_http_duration_seconds",
  help: "HTTP latency",
  labelNames: ["service", "route"],
  registers: [registry],
});
export async function server(service: string) {
  configureTracing(service);
  const spans = new WeakMap<object, Span>();
  const app = Fastify({
    logger: false,
    bodyLimit: 16384,
    requestTimeout: 15000,
    connectionTimeout: 10000,
    trustProxy: false,
    genReqId: () => randomUUID(),
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        // The local console uses HTTP; Safari otherwise upgrades its assets.
        upgradeInsecureRequests: process.env.FV_ENV === "local" ? null : [],
      },
    },
  });
  await app.register(rateLimit, { max: 120, timeWindow: 60000 });
  // JSON responses can contain tenant data, session state or signed file URLs.
  // Set this at send time so success and error responses share the same policy.
  app.addHook("onSend", async (_req, reply, payload) => {
    const type = String(reply.getHeader("content-type") ?? "");
    if (type.includes("application/json"))
      reply.header("cache-control", "no-store");
    return payload;
  });
  const timings = new WeakMap<object, bigint>();
  app.addHook("onRequest", async (req) => {
    timings.set(req, process.hrtime.bigint());
    spans.set(
      req,
      span("http.request", { "fv.service": service, "fv.request_id": req.id }),
    );
  });
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unmatched";
    const current = spans.get(req);
    if (current) {
      current.updateName(`${req.method} ${route}`);
      current.setAttribute("http.route", route);
      finish(current, reply.statusCode);
    }
    requests.inc({ service, route, status: reply.statusCode });
    latency.observe(
      { service, route },
      Number(
        process.hrtime.bigint() - (timings.get(req) ?? process.hrtime.bigint()),
      ) / 1e9,
    );
  });
  app.setErrorHandler((e, req, reply) => {
    const err = e as { statusCode?: number; name?: string };
    const code =
      err.name === "ZodError"
        ? 400
        : Number.isInteger(err.statusCode) &&
            err.statusCode! >= 400 &&
            err.statusCode! <= 599
          ? err.statusCode!
          : 500;
    console.error(
      JSON.stringify({
        event: "request.failed",
        service,
        requestId: req.id,
        status: code,
      }),
    );
    void reply.code(code).send({
      error:
        code >= 500
          ? "internal_error"
          : code === 403
            ? "forbidden"
            : code === 401
              ? "unauthorized"
              : "invalid_request",
      requestId: req.id,
    });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: "not_found", requestId: req.id }),
  );
  app.get("/health/live", async () => ({
    status: "ok",
    service,
    revision: process.env.FV_REVISION ?? "local",
  }));
  return app;
}
export function failure(event: string) {
  console.error(JSON.stringify({ event }));
}
export function fatal() {
  failure("service.failed");
  process.exit(1);
}
export async function shutdown(close: () => Promise<void>) {
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.once(sig, () => {
      void close()
        .then(() => flushTracing())
        .then(
          () => process.exit(0),
          () => process.exit(1),
        );
    });
}
