import { z } from "zod";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { denied } from "../../../packages/auth/index.ts";
import { tenant } from "../../../packages/database/index.ts";
import { applicationId } from "../../../packages/frontend-contracts/founder-village-team/index.ts";
import { sealTeamPayload, openTeamPayload, teamRequestHash } from "./crypto.ts";
import { teamActor } from "./local-login.ts";

export type TeamContext = {
  client: pg.PoolClient;
  actor: string;
  tenantId: string;
};

export async function actorFor(req: FastifyRequest, db: pg.Pool) {
  const actor = await teamActor(req, db);
  if (req.headers["x-application-id"] !== applicationId) denied(403);
  return actor;
}

export function teamScope(db: pg.Pool) {
  return async <T>(
    req: FastifyRequest,
    fn: (ctx: TeamContext) => Promise<T>,
  ) => {
    const actor = await actorFor(req, db);
    const tenantId = z.uuid().parse(req.headers["x-tenant-id"]);
    return tenant(db, actor, tenantId, (client) =>
      fn({ client, actor, tenantId }),
    );
  };
}

export async function mutate<T>(
  ctx: TeamContext,
  req: FastifyRequest,
  operation: string,
  input: unknown,
  codec: z.ZodType<T>,
  write: () => Promise<T>,
) {
  const { client, actor, tenantId } = ctx;
  const key = z.uuid().parse(req.headers["idempotency-key"]);
  const requestHash = teamRequestHash(tenantId, actor, key, operation, input);
  const receiptId = JSON.stringify([actor, key, requestHash]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([tenantId, actor, key]),
  ]);
  const { rows } = await client.query<{
    request_hash: string;
    payload: Buffer;
  }>(
    "SELECT request_hash,payload FROM app.team_receipts WHERE tenant_id=$1 AND actor=$2 AND key=$3",
    [tenantId, actor, key],
  );
  if (rows[0]) {
    if (rows[0].request_hash !== requestHash) denied(409);
    return codec.parse(
      openTeamPayload(tenantId, "receipt", receiptId, rows[0].payload),
    );
  }
  const result = codec.parse(await write());
  await client.query(
    "INSERT INTO app.team_receipts(tenant_id,actor,key,request_hash,payload) VALUES ($1,$2,$3,$4,$5)",
    [
      tenantId,
      actor,
      key,
      requestHash,
      sealTeamPayload(tenantId, "receipt", receiptId, result),
    ],
  );
  return result;
}
