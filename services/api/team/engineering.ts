import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { denied } from "../../../packages/auth/index.ts";
import {
  engineeringInputSchema,
  engineeringItemSchema,
  engineeringPageSchema,
  engineeringUpdateSchema,
} from "../../../packages/frontend-contracts/founder-village-team/engineering.ts";
import { mutate, type teamScope } from "./access.ts";
import { openTeamPayload, sealTeamPayload } from "./crypto.ts";

type Row = {
  tenant_id: string;
  id: string;
  payload: Buffer;
  status: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
};

const pageSize = 24;
const pageQuery = z.object({ after: z.uuid().optional() }).strict();
const idParams = z.object({ id: z.uuid() });
const basePath = "/team/engineering/items";

function item(row: Row) {
  const input = engineeringInputSchema.parse(
    openTeamPayload(row.tenant_id, "engineering", row.id, row.payload),
  );
  return engineeringItemSchema.parse({
    ...input,
    id: row.id,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

export function registerEngineeringRoutes(
  app: FastifyInstance,
  scoped: ReturnType<typeof teamScope>,
) {
  app.get(basePath, async (req) =>
    scoped(req, async ({ client, tenantId }) => {
      const { after } = pageQuery.parse(req.query);
      const { rows } = await client.query<Row>(
        `SELECT * FROM app.team_engineering_items WHERE tenant_id=$1
           AND ($2::uuid IS NULL OR (created_at,id) < (SELECT created_at,id
             FROM app.team_engineering_items WHERE tenant_id=$1 AND id=$2))
         ORDER BY created_at DESC,id DESC LIMIT $3`,
        [tenantId, after ?? null, pageSize + 1],
      );
      const visible = rows.slice(0, pageSize);
      return engineeringPageSchema.parse({
        items: visible.map(item),
        next: rows.length > pageSize ? visible.at(-1)!.id : null,
      });
    }),
  );

  app.post(basePath, async (req) =>
    scoped(req, async (ctx) => {
      const input = engineeringInputSchema.parse(req.body);
      return mutate(
        ctx,
        req,
        "engineering:create",
        input,
        engineeringItemSchema,
        async () => {
          const { client, tenantId } = ctx;
          const id = randomUUID();
          await client.query(
            "SELECT set_config('fv.engineering_request',$1,true)",
            [req.id],
          );
          const { rows } = await client.query<Row>(
            `INSERT INTO app.team_engineering_items(tenant_id,id,payload) VALUES($1,$2,$3) RETURNING *`,
            [tenantId, id, sealTeamPayload(tenantId, "engineering", id, input)],
          );
          return item(rows[0]!);
        },
      );
    }),
  );

  app.post(`${basePath}/:id/status`, async (req) =>
    scoped(req, async (ctx) => {
      const { id } = idParams.parse(req.params);
      const input = engineeringUpdateSchema.parse(req.body);
      return mutate(
        ctx,
        req,
        `engineering:status:${id}`,
        input,
        engineeringItemSchema,
        async () => {
          const { client, tenantId } = ctx;
          const {
            rows: [current],
          } = await client.query<Row>(
            "SELECT * FROM app.team_engineering_items WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            [tenantId, id],
          );
          if (!current) denied(404);
          if (current.revision !== input.revision) denied(409);
          if (current.status === input.status) return item(current);
          await client.query(
            "SELECT set_config('fv.engineering_request',$1,true)",
            [req.id],
          );
          const { rows } = await client.query<Row>(
            `UPDATE app.team_engineering_items SET status=$3,revision=revision+1,updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND id=$2 RETURNING *`,
            [tenantId, id, input.status],
          );
          return item(rows[0]!);
        },
      );
    }),
  );
}
