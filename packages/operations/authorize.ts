import type pg from "pg";
import { z } from "zod";
import { identity, local, environment, denied } from "../auth/index.ts";
import { fingerprint } from "./cloudflare.ts";
import { transaction, secret } from "../database/index.ts";
import { applications } from "../database/applications.ts";
import { operation } from "../contracts/index.ts";
export const assertion = z
  .object({
    id: z.string().uuid(),
    actor: z.string(),
    environment: z.enum(["local", "staging", "production"]),
    action: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Assertion = z.infer<typeof assertion>;
export async function authorizeOperation(
  db: pg.Pool,
  expected: Assertion,
): Promise<void> {
  assertion.parse(expected);
  operation.parse({ action: expected.action, parameters: expected.parameters });
  if (expected.environment !== environment()) denied(403);
  await transaction(db, async (c) => {
    const { rows } = await c.query<
      Assertion & {
        auth_proof: string | null;
        enabled: boolean;
        actions: string[];
        applications: string[];
      }
    >(
      "SELECT o.id,o.actor,o.environment,o.action,o.parameters,o.auth_proof,a.enabled,a.actions,a.applications FROM control.operations o JOIN control.administrators a ON a.actor=o.actor WHERE o.id=$1 AND o.state='running' FOR SHARE OF o",
      [expected.id],
    );
    const row = rows[0];
    if (
      !row ||
      !row.enabled ||
      !row.actions.includes(expected.action) ||
      fingerprint(
        assertion.parse({
          id: row.id,
          actor: row.actor,
          environment: row.environment,
          action: row.action,
          parameters: row.parameters,
        }),
      ) !== fingerprint(expected)
    )
      denied(403);
    if (
      "application" in expected.parameters
        ? !applications.some((a) => a.id === expected.parameters.application) ||
          !row.applications.includes(String(expected.parameters.application))
        : !applications.every((a) => row.applications.includes(a.id))
    )
      denied(403);
    const nonce = fingerprint(expected);
    if (!local()) {
      const roots = z
        .array(z.string())
        .min(1)
        .parse(JSON.parse(secret("ROOT_ADMIN_ACTORS")));
      if (
        !("application" in expected.parameters) &&
        !roots.includes(expected.actor)
      )
        denied(403);
      if (!row.auth_proof) denied(403);
      const who = await identity(row.auth_proof, true);
      const now = Date.now() / 1000;
      if (
        who.actor !== expected.actor ||
        who.claims.nonce !== nonce ||
        typeof who.claims.iat !== "number" ||
        !Number.isFinite(who.claims.iat) ||
        now - who.claims.iat > 300 ||
        who.claims.iat - now > 5 ||
        typeof who.claims.auth_time !== "number" ||
        !Number.isFinite(who.claims.auth_time) ||
        now - who.claims.auth_time > 300 ||
        who.claims.auth_time - now > 5
      )
        denied(403);
    }
    const consumed = await c.query(
      "INSERT INTO control.operation_authorizations(operation_id,nonce) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING operation_id",
      [expected.id, nonce],
    );
    await c.query("UPDATE control.operations SET auth_proof=NULL WHERE id=$1", [
      expected.id,
    ]);
    if (!consumed.rowCount)
      throw new Error(
        "operation authorization already consumed; reconcile before retry",
      );
  });
}
