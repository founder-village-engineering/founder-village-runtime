import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  local,
  environment,
  denied,
  randomToken,
  hash,
  type Identity,
} from "../../packages/auth/index.ts";
import { secret, audit, transaction } from "../../packages/database/index.ts";
import { assertion } from "../../packages/operations/authorize.ts";
import { fingerprint } from "../../packages/operations/cloudflare.ts";
export async function stepUpRoutes(
  app: FastifyInstance,
  db: pg.Pool,
  auth: (
    db: pg.Pool,
    req: FastifyRequest,
    action: string,
  ) => Promise<{ actor: string }>,
) {
  app.get("/auth/authorize/:id", async (req, reply) => {
    if (local()) denied(403);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    const result = await db.query(
      "SELECT id,actor,environment,action,parameters FROM control.operations WHERE id=$1 AND state='awaiting_authorization'",
      [id],
    );
    const row = result.rows[0];
    if (!row) denied(403);
    const expected = assertion.parse(row),
      who = await auth(db, req, expected.action);
    if (who.actor !== expected.actor) denied(403);
    const nonce = fingerprint(expected),
      state = randomToken(),
      verifier = randomToken();
    await db.query(
      "INSERT INTO control.login_attempts(id,verifier,nonce,expires_at,operation_id) VALUES($1,$2,$3,now()+interval '5 minutes',$4)",
      [hash(state), verifier, nonce, id],
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
      prompt: "login",
      max_age: "0",
    }).toString();
    return reply.redirect(url.href);
  });
}
export async function consumeApproval(
  db: pg.Pool,
  id: string,
  who: Identity,
  proof: string,
) {
  const now = Date.now() / 1000;
  for (const claim of [who.claims.iat, who.claims.auth_time]) {
    if (
      typeof claim !== "number" ||
      !Number.isFinite(claim) ||
      now - claim > 300 ||
      claim - now > 5
    )
      denied(403);
  }
  await transaction(db, async (c) => {
    const result = await c.query(
      "SELECT o.id,o.actor,o.environment,o.action,o.parameters,a.enabled,a.actions,a.applications FROM control.operations o JOIN control.administrators a ON a.actor=o.actor WHERE o.id=$1 AND o.actor=$2 AND o.state='awaiting_authorization' FOR UPDATE OF o FOR SHARE OF a",
      [id, who.actor],
    );
    const row = result.rows[0];
    if (!row || !row.enabled || !row.actions.includes(row.action)) denied(403);
    const expected = assertion.parse({
      id: row.id,
      actor: row.actor,
      environment: row.environment,
      action: row.action,
      parameters: row.parameters,
    });
    if (
      expected.environment !== environment() ||
      fingerprint(expected) !== who.claims.nonce ||
      ("application" in expected.parameters &&
        !row.applications.includes(String(expected.parameters.application)))
    )
      denied(403);
    const updated = await c.query(
      "UPDATE control.operations SET auth_proof=$2,state='queued',updated_at=now() WHERE id=$1 AND state='awaiting_authorization'",
      [id, proof],
    );
    if (updated.rowCount !== 1) denied(403);
    await audit(c, who.actor, "operation.authorize", id, "succeeded", id);
  });
}
