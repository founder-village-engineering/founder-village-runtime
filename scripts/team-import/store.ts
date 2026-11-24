import type pg from "pg";
import { isDeepStrictEqual } from "node:util";
import { transaction } from "../../packages/database/index.ts";
import {
  sealTeamPayload,
  openTeamPayload,
} from "../../services/api/team/crypto.ts";
import {
  requireImport,
  ImportFailure,
  sourceHash,
  validateArchive,
  type Mapping,
  type Archive,
} from "./archive.ts";

type Kind = "bot" | "conversation" | "message";
const tables = {
  bot: "app.team_bots",
  conversation: "app.team_conversations",
  message: "app.team_messages",
};
function identity(team: string, kind: Kind, ...parts: string[]) {
  const sourceId = sourceHash(team, kind, ...parts);
  // UUIDv8 with a SHA-256 namespace. Stable across retries and actor renames.
  const id = [
    sourceId.slice(0, 8),
    sourceId.slice(8, 12),
    "8" + sourceId.slice(13, 16),
    ((parseInt(sourceId[16]!, 16) & 3) | 8).toString(16) +
      sourceId.slice(17, 20),
    sourceId.slice(20, 32),
  ].join("-");
  return { id, sourceId };
}
type Key = ReturnType<typeof identity>;
type Columns = Record<string, string | string[] | number | null>;
async function store(
  client: pg.PoolClient,
  tenant: string,
  kind: Kind,
  key: Key,
  metadata: Columns,
  content: object,
) {
  // Table and column names are fixed by the three calls below. All archive values are parameters.
  const table = tables[kind];
  const columns = Object.keys(metadata);
  const fields = ["tenant_id", "id", "source_id", ...columns];
  const values = [tenant, key.id, key.sourceId, ...Object.values(metadata)];
  const slots = fields.map((_, i) => "$" + (i + 1));
  const inserted = await client.query(
    `INSERT INTO ${table} (${fields.join(",")},payload) VALUES (${slots.join(",")},$${values.length + 1})
    ON CONFLICT DO NOTHING`,
    [...values, sealTeamPayload(tenant, kind, key.id, content)],
  );
  if (inserted.rowCount === 1) return true;
  const same = fields
    .map((field, i) => `${field} IS NOT DISTINCT FROM ${slots[i]}`)
    .join(" AND ");
  const replay = await client.query<{ payload: Buffer }>(
    `SELECT payload FROM ${table} WHERE ${same}`,
    values,
  );
  requireImport(
    replay.rows.length === 1 &&
      isDeepStrictEqual(
        openTeamPayload(tenant, kind, key.id, replay.rows[0]!.payload),
        content,
      ),
    "An existing record differs from the reviewed export.",
  );
  return false;
}
export async function importArchive(
  db: pg.Pool,
  archive: Archive,
  mapping: Mapping,
) {
  const members = validateArchive(archive, mapping);
  const tenant = mapping.tenant;
  return transaction(db, async (client) => {
    const check = await client.query("SELECT current_database() AS db");
    requireImport(
      check.rows[0]?.db === "founder-village-team",
      "The connection targets another database.",
    );
    const found = await client.query(
      "SELECT id FROM app.tenants WHERE id=$1 FOR UPDATE",
      [tenant],
    );
    requireImport(
      found.rowCount === 1,
      "The destination tenant does not exist.",
    );
    // Verify the key against existing destination ciphertext before accepting new records.
    const prior = await client.query<{
      kind: Kind;
      id: string;
      payload: Buffer;
    }>(
      `(SELECT 'bot' AS kind, id, payload FROM app.team_bots WHERE tenant_id=$1 LIMIT 1)
       UNION ALL
       (SELECT 'conversation' AS kind, id, payload FROM app.team_conversations WHERE tenant_id=$1 LIMIT 1)`,
      [tenant],
    );
    try {
      for (const row of prior.rows)
        openTeamPayload(tenant, row.kind, row.id, row.payload);
    } catch {
      throw new ImportFailure(
        "The supplied content key could not open existing destination records.",
      );
    }
    // Hold the verified roster stable during writes and across concurrent grants.
    await client.query("LOCK TABLE app.memberships IN SHARE MODE");
    const { rows } = await client.query<{ actor: string }>(
      "SELECT actor FROM app.memberships WHERE tenant_id=$1 AND enabled",
      [tenant],
    );
    const active = new Set(rows.map((m) => m.actor));
    requireImport(
      [...members.values()].every((actor) => active.has(actor)),
      "A mapped actor lacks an active destination membership.",
    );
    requireImport(
      !archive.bots.some((b) => b.visibility === "team") ||
        active.size === members.size,
      "Team-wide sharing requires the exact reviewed active membership roster.",
    );
    const source = sourceHash("grok-bot-team", archive.team);
    await client.query(
      "INSERT INTO app.team_import_origins(tenant_id,source_team_key) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [tenant, source],
    );
    const origin = await client.query(
      "SELECT 1 FROM app.team_import_origins WHERE tenant_id=$1 AND source_team_key=$2",
      [tenant, source],
    );
    requireImport(
      origin.rowCount === 1,
      "The source is already bound to a different destination or the destination to a different source.",
    );
    for (const [member, actor] of members) {
      const key = sourceHash(archive.team, "member", member);
      await client.query(
        "INSERT INTO app.team_import_members(tenant_id,source_member_key,actor) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [tenant, key, actor],
      );
      const bound = await client.query(
        "SELECT 1 FROM app.team_import_members WHERE tenant_id=$1 AND source_member_key=$2 AND actor=$3",
        [tenant, key, actor],
      );
      requireImport(
        bound.rowCount === 1,
        "A source or destination member already has a different identity binding.",
      );
    }
    const inserted = { bots: 0, conversations: 0, messages: 0 };
    // Source ownership belongs on the imported row. Attribute the migration itself to its operator role.
    await client.query(
      "SELECT set_config('fv.actor','operator:' || session_user,true),set_config('fv.tenant',$1,true)",
      [tenant],
    );
    for (const b of archive.bots) {
      const owner = members.get(b.owner)!;
      if (
        await store(
          client,
          tenant,
          "bot",
          identity(archive.team, "bot", b.id),
          {
            owner_actor: owner,
            visibility: b.visibility,
            reader_actors: b.readers.map((id) => members.get(id)!).sort(),
            manager_actors: b.managers.map((id) => members.get(id)!).sort(),
            created_at: b.createdAt,
          },
          {
            name: b.name,
            description: b.description,
            instructions: b.instructions,
            configuration: b.configuration,
          },
        )
      )
        inserted.bots++;
    }
    for (const c of archive.conversations) {
      const owner = members.get(c.owner)!;
      const key = identity(archive.team, "conversation", c.owner, c.id);
      if (
        await store(
          client,
          tenant,
          "conversation",
          key,
          {
            owner_actor: owner,
            bot_id:
              c.bot === null ? null : identity(archive.team, "bot", c.bot).id,
            created_at: c.createdAt,
          },
          { title: c.title },
        )
      )
        inserted.conversations++;
      for (const [i, m] of c.messages.entries()) {
        const content = {
          content: m.content,
          ...(m.authorName === undefined ? {} : { authorName: m.authorName }),
        };
        if (
          await store(
            client,
            tenant,
            "message",
            identity(archive.team, "message", c.owner, c.id, m.id),
            {
              conversation_id: key.id,
              role: m.role,
              position: i + 1,
              created_at: m.createdAt,
            },
            content,
          )
        )
          inserted.messages++;
      }
    }
    await client.query(
      "INSERT INTO app.team_import_batches(tenant_id,archive_digest,bot_count,conversation_count,message_count) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [
        tenant,
        mapping.exportSha256,
        mapping.expected.bots,
        mapping.expected.conversations,
        mapping.expected.messages,
      ],
    );
    return inserted;
  });
}
