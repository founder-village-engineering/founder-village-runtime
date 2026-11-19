import { boundedJson } from "../../packages/observability/http.ts";
import { stepUpRoutes, consumeApproval } from "./stepup.ts";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import type pg from "pg";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  accessGate,
  identity,
  localToken,
  local,
  hash,
  randomToken,
  denied,
  sameOrigin,
  equal,
} from "../../packages/auth/index.ts";
import { audit, secret, transaction } from "../../packages/database/index.ts";
import { applications } from "../../packages/database/applications.ts";
const resolvedActors = new WeakMap<FastifyRequest, string>();
export const requestActor = (req: FastifyRequest) =>
  resolvedActors.get(req) ?? "unknown";
type Session = {
  actor: string;
  actions: string[];
  applications: string[];
  csrf_hash: string;
};
async function currentSession(db: pg.Pool, token: string | undefined) {
  if (!token || token.length > 512) return undefined;
  const { rows } = await db.query<Session>(
    "SELECT s.actor,a.actions,a.applications,s.csrf_hash FROM control.sessions s JOIN control.administrators a USING(actor) WHERE token_hash=$1 AND expires_at>now() AND a.enabled",
    [hash(token)],
  );
  return rows[0];
}
export async function authenticate(
  db: pg.Pool,
  req: FastifyRequest,
  action = "dashboard.read",
) {
  await accessGate(req);
  const user = await currentSession(db, req.cookies.fv_session);
  if (!user) denied();
  resolvedActors.set(req, user.actor);
  if (!user.actions.includes(action)) {
    await audit(db, user.actor, action, "admin", "denied");
    denied(403);
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    sameOrigin(req);
    const csrf = req.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !equal(hash(csrf), user.csrf_hash))
      denied(403);
  }
  return user;
}
export async function authRoutes(app: FastifyInstance, db: pg.Pool) {
  await app.register(cookie);
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.split("?", 1)[0]?.startsWith("/auth/")) {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
    }
  });
  await stepUpRoutes(app, db, authenticate);
  async function session(
    actor: string,
    reply: FastifyReply,
    previous?: string,
    secure = !local(),
  ) {
    const token = randomToken(),
      csrf = randomToken();
    await transaction(db, async (c) => {
      const { rowCount } = await c.query(
        "SELECT actor FROM control.administrators WHERE actor=$1 AND enabled FOR SHARE",
        [actor],
      );
      if (!rowCount) denied(403);
      if (previous)
        await c.query("DELETE FROM control.sessions WHERE token_hash=$1", [
          hash(previous),
        ]);
      await c.query(
        "INSERT INTO control.sessions(token_hash,actor,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
        [hash(token), actor, hash(csrf)],
      );
      await audit(c, actor, "session.create", "admin", "succeeded");
    });
    reply.setCookie("fv_session", token, {
      path: "/",
      httpOnly: true,
      secure,
      sameSite: "strict",
      maxAge: 3600,
    });
    reply.setCookie("fv_csrf", csrf, {
      path: "/",
      httpOnly: false,
      secure,
      sameSite: "strict",
      maxAge: 3600,
    });
  }
  app.get("/auth/status", async (req) => {
    await accessGate(req);
    return {
      local: local(),
      fixtureLogin: local() && process.env.FV_LOCAL_AUTH_FIXTURES === "1",
      authenticated: !!(await currentSession(db, req.cookies.fv_session)),
    };
  });
  app.post(
    "/auth/local",
    { config: { rateLimit: { max: 20, timeWindow: 60000 } } },
    async (req, reply) => {
      if (
        !local() ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip)
      )
        denied(403);
      sameOrigin(req);
      let actor: string;
      if (process.env.FV_LOCAL_AUTH_FIXTURES === "1") {
        actor = (await identity(await localToken("owner"), true)).actor;
      } else {
        const code = (req.body as { code?: unknown } | undefined)?.code;
        if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code))
          denied();
        actor = await transaction(db, async (c) => {
          const result = await c.query<{
            actor: string;
            actions: string[];
            applications: string[];
          }>(
            "DELETE FROM control.local_admin_codes code USING control.administrators a WHERE code.token_hash=$1 AND code.expires_at>now() AND a.actor=code.actor AND a.enabled RETURNING code.actor,a.actions,a.applications",
            [hash(code)],
          );
          const row = result.rows[0];
          const roots = z
            .array(z.string())
            .parse(JSON.parse(secret("ROOT_ADMIN_ACTORS")));
          if (
            !row ||
            !roots.includes(row.actor) ||
            !row.actions.includes("admins.manage") ||
            !applications.every((a) => row.applications.includes(a.id))
          )
            denied();
          await audit(
            c,
            row.actor,
            "session.code.consume",
            "local-admin",
            "consumed",
          );
          return row.actor;
        });
      }
      await session(
        actor,
        reply,
        req.cookies.fv_session,
        req.headers.origin?.startsWith("https://"),
      );
      return { status: "signed_in" };
    },
  );
  app.get("/auth/login", async (req, reply) => {
    await accessGate(req);
    if (local()) return reply.redirect("/");
    const state = randomToken(),
      verifier = randomToken(),
      nonce = randomToken();
    await db.query(
      "INSERT INTO control.login_attempts(id,verifier,nonce,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",
      [hash(state), verifier, nonce],
    );
    reply.setCookie("fv_login", state, {
      path: "/auth",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 300,
    });
    const url = new URL(secret("OIDC_AUTHORIZATION_ENDPOINT"));
    url.search = new URLSearchParams({
      client_id: secret("OIDC_CLIENT_ID"),
      redirect_uri: `${secret("ADMIN_ORIGIN")}/auth/callback`,
      response_type: "code",
      scope: "openid",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      acr_values: secret("OIDC_MFA_ACR"),
      max_age: "3600",
    }).toString();
    return reply.redirect(url.href);
  });
  app.get("/auth/callback", async (req, reply) => {
    await accessGate(req);
    if (local()) denied();
    const input = z
      .object({
        state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        code: z.string().min(1).max(4096),
      })
      .parse(req.query);
    if (req.cookies.fv_login !== input.state) denied();
    const { rows } = await db.query<{
      verifier: string;
      nonce: string;
      operation_id: string | null;
    }>(
      "DELETE FROM control.login_attempts WHERE id=$1 AND expires_at>now() RETURNING verifier,nonce,operation_id",
      [hash(input.state)],
    );
    const attempt = rows[0];
    if (!attempt) denied();
    const response = await fetch(secret("OIDC_TOKEN_ENDPOINT"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: secret("OIDC_CLIENT_ID"),
        code: input.code,
        redirect_uri: `${secret("ADMIN_ORIGIN")}/auth/callback`,
        code_verifier: attempt.verifier,
      }),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok) denied();
    const payload = z
      .object({ id_token: z.string().max(12000) })
      .parse(await boundedJson(response, 16384));
    const who = await identity(payload.id_token, true);
    if (who.claims.nonce !== attempt.nonce) denied();
    if (attempt.operation_id)
      await consumeApproval(db, attempt.operation_id, who, payload.id_token);
    await session(who.actor, reply, req.cookies.fv_session);
    reply.clearCookie("fv_login", { path: "/auth" });
    return reply.redirect("/");
  });
  app.post("/auth/logout", async (req, reply) => {
    const who = await authenticate(db, req);
    await transaction(db, async (c) => {
      await c.query("DELETE FROM control.sessions WHERE token_hash=$1", [
        hash(req.cookies.fv_session!),
      ]);
      await audit(c, who.actor, "session.revoke", "admin", "succeeded");
    });
    reply.clearCookie("fv_session", { path: "/" });
    reply.clearCookie("fv_csrf", { path: "/" });
    return { status: "signed_out" };
  });
}
