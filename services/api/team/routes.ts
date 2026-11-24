import { randomUUID } from "node:crypto";
import { z } from "zod";
import { registerLocalTeamLogin } from "./local-login.ts";
import { actorFor, mutate, teamScope, type TeamContext } from "./access.ts";
import { registerEngineeringRoutes } from "./engineering.ts";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { denied, hash } from "../../../packages/auth/index.ts";
import { transaction } from "../../../packages/database/index.ts";
import {
  tenantsSchema,
  capabilitiesSchema,
  botInputSchema,
  botUpdateSchema,
  conversationInputSchema,
  messageInputSchema,
  replyInputSchema,
  botSchema,
  conversationSchema,
  messageSchema,
  botConfigurationSchema,
  botsSchema,
  conversationsSchema,
  messagesSchema,
  pageQuerySchema,
  botViewQuerySchema,
  botPageQuerySchema,
  teamPageSize,
  messagePageQuerySchema,
  messageContentQuerySchema,
  messageContentChunkSchema,
} from "../../../packages/frontend-contracts/founder-village-team/index.ts";
import { sealTeamPayload, openTeamPayload } from "./crypto.ts";
import { generateReply, repliesAvailable, RejectedReply } from "./xai.ts";

type Row = {
  tenant_id: string;
  id: string;
  created_iso: string;
  payload: Buffer;
};
type BotRow = Row & {
  owner_actor: string;
  manager_actors: string[];
  visibility: "private" | "team" | "selected";
};
type ChatRow = Row & { bot_id: string | null };
type MessageRow = Row & {
  conversation_id: string;
  position: string;
  role: string;
};
const botBody = z.object({
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  configuration: botConfigurationSchema,
});
const chatBody = z.object({ title: z.string() });
const messageBody = z.object({
  content: z.string(),
  authorName: z.string().optional(),
});
const idParams = z.object({ id: z.uuid() });
// Format the original PostgreSQL timestamp before the pg Date parser drops microseconds.
const recordColumns = `*, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_iso`;

const directoryFields = botBody.pick({ name: true, description: true });
function previewField(value: string, max: number) {
  if (value.length <= max) return value;
  return value.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/u, "") + "…";
}
function visibleBot(row: BotRow, actor: string, view?: "directory") {
  const body = openTeamPayload(row.tenant_id, "bot", row.id, row.payload);
  const canManage =
    row.owner_actor === actor || row.manager_actors.includes(actor);
  const metadata = {
    id: row.id,
    createdAt: row.created_iso,
    visibility: row.visibility,
    canManage,
  };
  if (view === "directory" || !canManage) {
    const { name, description } = directoryFields.parse(body);
    return botSchema.parse({
      ...metadata,
      name: view ? previewField(name, 240) : name,
      description: view ? previewField(description, 2000) : description,
      instructions: null,
      configuration: null,
    });
  }
  return botSchema.parse({ ...botBody.parse(body), ...metadata });
}
function chat(row: ChatRow) {
  return conversationSchema.parse({
    ...chatBody.parse(
      openTeamPayload(row.tenant_id, "conversation", row.id, row.payload),
    ),
    id: row.id,
    createdAt: row.created_iso,
    botId: row.bot_id,
  });
}
function message(row: MessageRow) {
  const { content, authorName } = messageBody.parse(
    openTeamPayload(row.tenant_id, "message", row.id, row.payload),
  );
  return messageSchema.parse({
    content,
    authorName: authorName ?? null,
    id: row.id,
    createdAt: row.created_iso,
    conversationId: row.conversation_id,
    role: row.role,
    position: Number(row.position),
  });
}
function page<R extends { id: string }, T>(rows: R[], project: (row: R) => T) {
  const displayed = rows.slice(0, teamPageSize);
  return {
    items: displayed.map(project),
    next: rows.length > displayed.length ? displayed.at(-1)!.id : null,
  };
}

// The shared browser client accepts at most 1 MiB. Ciphertext includes the
// serialized JSON fields. Reserve room for the row IDs, timestamp, role,
// position and JSON framing before materializing payloads from PostgreSQL.
const pageByteLimit = 1_048_576;
const rowOverhead = 512;
const chunkChars = 64_000;

function contentChunk(
  msg: { content: string; authorName: string | null },
  offset: number,
) {
  const end = offset + chunkChars;
  const length = Math.max(msg.content.length, msg.authorName?.length ?? 0);
  if (offset >= length && offset !== 0) denied(416);
  return {
    content: msg.content.slice(offset, end),
    authorName:
      msg.authorName === null ? null : msg.authorName.slice(offset, end),
    nextOffset: end < length ? end : null,
  };
}

async function listMessages(
  ctx: TeamContext,
  chatId: string,
  after: string | undefined,
  newest: boolean,
) {
  const { client, tenantId } = ctx;
  const direction = newest ? "DESC" : "ASC";
  const cursor = after
    ? `AND position ${newest ? "<" : ">"} (SELECT position FROM app.team_messages WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3)`
    : "";
  const { rows: candidates } = await client.query<{
    id: string;
    bytes: number;
  }>(
    `SELECT id, octet_length(payload) AS bytes FROM app.team_messages
     WHERE tenant_id=$1 AND conversation_id=$2 ${cursor}
     ORDER BY position ${direction} LIMIT ${teamPageSize + 1}`,
    after ? [tenantId, chatId, after] : [tenantId, chatId],
  );
  let bytes = 128;
  const ids: string[] = [];
  for (const row of candidates.slice(0, teamPageSize)) {
    bytes += row.bytes + rowOverhead;
    if (ids.length && bytes > pageByteLimit) break;
    ids.push(row.id);
  }
  if (!ids.length) return { items: [], next: null };
  const { rows } = await client.query<MessageRow>(
    `SELECT ${recordColumns} FROM app.team_messages WHERE tenant_id=$1 AND conversation_id=$2 AND id=ANY($3::uuid[]) ORDER BY position ${direction}`,
    [tenantId, chatId, ids],
  );
  const items = rows.map(message);
  if (candidates[0]!.bytes + rowOverhead + 128 > pageByteLimit) {
    const row = items[0]!,
      chunk = contentChunk(row, 0);
    if (chunk.nextOffset !== null)
      items[0] = { ...row, ...chunk, nextOffset: chunk.nextOffset };
  }
  return messagesSchema.parse({
    items,
    next: candidates.length > ids.length ? ids.at(-1) : null,
  });
}
async function requireChat({ client, tenantId }: TeamContext, id: string) {
  const result = await client.query<ChatRow>(
    `SELECT ${recordColumns} FROM app.team_conversations WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id],
  );
  return result.rows[0] ?? denied(404);
}
async function requireBot({ client, tenantId }: TeamContext, id: string) {
  const result = await client.query<BotRow>(
    `SELECT ${recordColumns} FROM app.team_bots WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id],
  );
  return result.rows[0] ?? denied(404);
}
async function lockChat({ client, tenantId }: TeamContext, chatId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [
    JSON.stringify([tenantId, chatId]),
  ]);
}
async function insertMessage(
  { client, tenantId }: TeamContext,
  chatId: string,
  role: "user" | "assistant",
  content: string,
  inReplyTo?: string,
) {
  const id = randomUUID();
  const { rows } = await client.query<MessageRow>(
    `INSERT INTO app.team_messages(tenant_id,conversation_id,id,position,role,payload,in_reply_to)
     SELECT $1,$2,$3,coalesce(max(position),0)+1,$4,$5,$6 FROM app.team_messages WHERE tenant_id=$1 AND conversation_id=$2
     RETURNING ${recordColumns}`,
    [
      tenantId,
      chatId,
      id,
      role,
      sealTeamPayload(tenantId, "message", id, { content }),
      inReplyTo ?? null,
    ],
  );
  return message(rows[0]!);
}

export function registerTeamRoutes(app: FastifyInstance, db: pg.Pool) {
  registerLocalTeamLogin(app, db);
  const scoped = teamScope(db);
  registerEngineeringRoutes(app, scoped);
  app.get("/team/tenants", async (req) => {
    const actor = await actorFor(req, db);
    return transaction(db, async (client) => {
      await client.query("SELECT set_config('fv.actor',$1,true)", [actor]);
      return tenantsSchema.parse(
        (
          await client.query(
            "SELECT id,name FROM app.my_tenants() ORDER BY name,id",
          )
        ).rows,
      );
    });
  });
  app.get("/team/capabilities", async (req) =>
    scoped(req, async () =>
      capabilitiesSchema.parse({ repliesAvailable: repliesAvailable() }),
    ),
  );
  app.get("/team/bots", async (req) =>
    scoped(req, async ({ client, tenantId, actor }) => {
      const { after, view } = botPageQuerySchema.parse(req.query);
      const { rows } = await client.query<BotRow>(
        `SELECT ${recordColumns} FROM app.team_bots WHERE tenant_id=$1 AND ($2::uuid IS NULL OR (created_at,id) <
      (SELECT created_at,id FROM app.team_bots WHERE tenant_id=$1 AND id=$2)) ORDER BY created_at DESC,id DESC LIMIT $3`,
        [tenantId, after ?? null, teamPageSize + 1],
      );
      return botsSchema.parse(page(rows, (r) => visibleBot(r, actor, view)));
    }),
  );
  app.get("/team/bots/:id", async (req) =>
    scoped(req, async (ctx) => {
      const { id } = idParams.parse(req.params);
      const { view } = botViewQuerySchema.parse(req.query);
      return visibleBot(await requireBot(ctx, id), ctx.actor, view);
    }),
  );
  app.post("/team/bots", async (req) =>
    scoped(req, async (ctx) => {
      const { client, tenantId, actor } = ctx,
        input = botInputSchema.parse(req.body);
      return mutate(ctx, req, "createBot", input, botSchema, async () => {
        const id = randomUUID(),
          { visibility, ...body } = input;
        const { rows } = await client.query<BotRow>(
          `INSERT INTO app.team_bots(tenant_id,id,owner_actor,visibility,payload) VALUES($1,$2,$3,$4,$5) RETURNING ${recordColumns}`,
          [
            tenantId,
            id,
            actor,
            visibility,
            sealTeamPayload(tenantId, "bot", id, {
              ...body,
              configuration: {},
            }),
          ],
        );
        return visibleBot(rows[0]!, actor);
      });
    }),
  );
  app.post("/team/bots/:id", async (req) =>
    scoped(req, async (ctx) => {
      const { id } = idParams.parse(req.params),
        input = botUpdateSchema.parse(req.body);
      const { actor, client, tenantId } = ctx;
      const current = await requireBot(ctx, id);
      if (
        current.owner_actor !== actor &&
        !current.manager_actors.includes(actor)
      )
        denied(403);
      return mutate(ctx, req, `editBot:${id}`, input, botSchema, async () => {
        const { rows } = await client.query<BotRow>(
          `SELECT ${recordColumns} FROM app.team_bots WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [tenantId, id],
        );
        const row = rows[0] ?? denied(403);
        const data = botBody.parse(
          openTeamPayload(tenantId, "bot", id, row.payload),
        );
        const changed = await client.query<BotRow>(
          `UPDATE app.team_bots SET payload=$3 WHERE tenant_id=$1 AND id=$2 RETURNING ${recordColumns}`,
          [
            tenantId,
            id,
            sealTeamPayload(tenantId, "bot", id, { ...data, ...input }),
          ],
        );
        return visibleBot(changed.rows[0]!, actor);
      });
    }),
  );
  app.get("/team/conversations", async (req) =>
    scoped(req, async ({ client, tenantId }) => {
      const { after } = pageQuerySchema.parse(req.query);
      const { rows } = await client.query<ChatRow>(
        `SELECT ${recordColumns} FROM app.team_conversations WHERE tenant_id=$1 AND ($2::uuid IS NULL OR (created_at,id) <
      (SELECT created_at,id FROM app.team_conversations WHERE tenant_id=$1 AND id=$2)) ORDER BY created_at DESC,id DESC LIMIT $3`,
        [tenantId, after ?? null, teamPageSize + 1],
      );
      return conversationsSchema.parse(page(rows, chat));
    }),
  );
  app.get("/team/conversations/:id", async (req) =>
    scoped(req, async (ctx) => {
      const { id } = idParams.parse(req.params);
      return chat(await requireChat(ctx, id));
    }),
  );
  app.post("/team/conversations", async (req) =>
    scoped(req, async (ctx) => {
      const { client, tenantId, actor } = ctx,
        input = conversationInputSchema.parse(req.body);
      return mutate(
        ctx,
        req,
        "createConversation",
        input,
        conversationSchema,
        async () => {
          if (input.botId) await requireBot(ctx, input.botId);
          const id = randomUUID(),
            { rows } = await client.query<ChatRow>(
              `INSERT INTO app.team_conversations(tenant_id,id,owner_actor,bot_id,payload)
        VALUES($1,$2,$3,$4,$5) RETURNING ${recordColumns}`,
              [
                tenantId,
                id,
                actor,
                input.botId ?? null,
                sealTeamPayload(tenantId, "conversation", id, {
                  title: input.title,
                }),
              ],
            );
          return chat(rows[0]!);
        },
      );
    }),
  );
  app.get("/team/conversations/:id/messages", async (req) =>
    scoped(req, async (ctx) => {
      const { id } = idParams.parse(req.params),
        { after, order } = messagePageQuerySchema.parse(req.query);
      await requireChat(ctx, id);
      return listMessages(ctx, id, after, order === "newest");
    }),
  );
  app.get("/team/conversations/:id/messages/:messageId/content", async (req) =>
    scoped(req, async (ctx) => {
      const { id, messageId } = idParams
        .extend({ messageId: z.uuid() })
        .parse(req.params);
      const { offset } = messageContentQuerySchema.parse(req.query);
      await requireChat(ctx, id);
      const { rows } = await ctx.client.query<MessageRow>(
        `SELECT ${recordColumns} FROM app.team_messages WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3`,
        [ctx.tenantId, id, messageId],
      );
      const row = rows[0] ?? denied(404);
      return messageContentChunkSchema.parse(
        contentChunk(message(row), offset),
      );
    }),
  );
  app.post("/team/conversations/:id/messages", async (req) =>
    scoped(req, async (ctx) => {
      const { id } = idParams.parse(req.params),
        input = messageInputSchema.parse(req.body);
      await requireChat(ctx, id);
      return mutate(
        ctx,
        req,
        `message:${id}`,
        input,
        messageSchema,
        async () => {
          await lockChat(ctx, id);
          return insertMessage(ctx, id, "user", input.content);
        },
      );
    }),
  );
  app.post("/team/conversations/:id/replies", async (req) => {
    const { id } = idParams.parse(req.params),
      input = replyInputSchema.parse(req.body);
    const reservation = await scoped(req, async (ctx) => {
      const current = await requireChat(ctx, id);
      await mutate(
        ctx,
        req,
        `reply:${id}`,
        input,
        z.uuid(),
        async () => input.messageId,
      );
      await lockChat(ctx, id);
      const args = [ctx.tenantId, id, input.messageId];
      const previous = await ctx.client.query<MessageRow>(
        `SELECT ${recordColumns} FROM app.team_messages WHERE tenant_id=$1 AND conversation_id=$2 AND in_reply_to=$3`,
        args,
      );
      if (previous.rows[0])
        return {
          kind: "completed" as const,
          message: message(previous.rows[0]),
        };
      if (!repliesAvailable()) denied(503);
      const { rows } = await ctx.client.query<MessageRow>(
        `SELECT ${recordColumns} FROM app.team_messages WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY position DESC LIMIT 32`,
        args.slice(0, 2),
      );
      if (rows[0]?.id !== input.messageId || rows[0].role !== "user")
        denied(409);
      const bot = current.bot_id ? await requireBot(ctx, current.bot_id) : null;
      const instructions = bot
        ? botBody.parse(
            openTeamPayload(ctx.tenantId, "bot", bot.id, bot.payload),
          ).instructions
        : "";
      const history = rows
        .reverse()
        .filter((row) => row.role === "user" || row.role === "assistant")
        .map((row) => ({ role: row.role, content: message(row).content }));
      const claim = await ctx.client.query(
        `INSERT INTO app.team_reply_attempts(tenant_id,conversation_id,message_id) VALUES ($1,$2,$3)
        ON CONFLICT (tenant_id,conversation_id,message_id) DO UPDATE SET state='reserved',updated_at=now() WHERE app.team_reply_attempts.state='rejected'
        RETURNING message_id`,
        args,
      );
      if (!claim.rowCount) denied(409);
      return { kind: "reserved" as const, instructions, history, args };
    });
    if (reservation.kind === "completed") return reservation.message;
    const finish = (ctx: TeamContext, state: string) =>
      ctx.client.query(
        "UPDATE app.team_reply_attempts SET state=$4,updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND message_id=$3 AND state='reserved'",
        [...reservation.args, state],
      );
    let content: string;
    try {
      content = await generateReply(
        reservation.instructions,
        reservation.history,
        hash(JSON.stringify(reservation.args)),
      );
    } catch (error) {
      await scoped(req, (ctx) =>
        finish(ctx, error instanceof RejectedReply ? "rejected" : "uncertain"),
      );
      throw error;
    }
    return scoped(req, async (ctx) => {
      await lockChat(ctx, id);
      await finish(ctx, "completed");
      return insertMessage(ctx, id, "assistant", content, input.messageId);
    });
  });
}
