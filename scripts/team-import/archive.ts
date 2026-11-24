import { createHash } from "node:crypto";
import { z } from "zod";
import { botConfigurationSchema } from "../../packages/frontend-contracts/founder-village-team/index.ts";

const sourceId = z.string().min(1).max(512);
const time = z.iso
  .datetime({ offset: true })
  .refine((value) => !/\.\d{7}/.test(value));
const ids = z.array(sourceId);
const count = z.number().int().nonnegative();
const counts = z.strictObject({
  bots: count,
  conversations: count,
  messages: count,
});

const bot = z.strictObject({
  id: sourceId,
  owner: sourceId,
  visibility: z.enum(["private", "selected", "team"]),
  readers: ids,
  managers: ids,
  createdAt: time,
  name: z.string().min(1),
  description: z.string(),
  instructions: z.string(),
  configuration: botConfigurationSchema,
});
const message = z.strictObject({
  id: sourceId,
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  createdAt: time,
  authorName: z.string().min(1).optional(),
});
const conversation = z.strictObject({
  id: sourceId,
  visibility: z.literal("private"),
  owner: sourceId,
  bot: sourceId.nullable(),
  title: z.string().min(1),
  createdAt: time,
  messages: z.array(message),
});
export const archiveSchema = z.strictObject({
  format: z.literal("founder-village-grok-import-v1"),
  team: sourceId,
  bots: z.array(bot),
  conversations: z.array(conversation),
});
export const mappingSchema = z.strictObject({
  team: sourceId,
  tenant: z.uuid(),
  exportSha256: z.string().regex(/^[0-9a-f]{64}$/),
  expected: counts,
  members: z
    .array(
      z.strictObject({
        source: sourceId,
        actor: z
          .string()
          .max(512)
          .regex(/^.+\|.+$/),
      }),
    )
    .min(1),
});
export type Archive = z.infer<typeof archiveSchema>;
export type Mapping = z.infer<typeof mappingSchema>;
export class ImportFailure extends Error {}
export function requireImport(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new ImportFailure(message);
}
function unique(values: string[]) {
  requireImport(
    new Set(values).size === values.length,
    "Duplicate source identity or access entry.",
  );
}
export function sourceHash(...path: string[]) {
  return createHash("sha256").update(JSON.stringify(path)).digest("hex");
}
function epochMicros(value: string) {
  const fraction = value.match(/\.(\d+)/)?.[1] ?? "";
  return (
    BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3))
  );
}
export function inventory(data: Archive) {
  return {
    bots: data.bots.length,
    conversations: data.conversations.length,
    messages: data.conversations.reduce((n, c) => n + c.messages.length, 0),
  };
}
export function validateArchive(data: Archive, config: Mapping) {
  requireImport(
    data.team === config.team,
    "The archive and mapping identify different teams.",
  );
  unique(config.members.map((m) => m.source));
  unique(config.members.map((m) => m.actor));
  unique(data.bots.map((b) => b.id));
  unique(data.conversations.map((c) => sourceHash(c.owner, c.id)));
  const member = new Map(config.members.map((m) => [m.source, m.actor]));
  const bots = new Map(data.bots.map((b) => [b.id, b]));
  for (const b of data.bots) {
    unique([b.owner, ...b.readers, ...b.managers]);
    requireImport(
      [b.owner, ...b.readers, ...b.managers].every((id) => member.has(id)),
      "A bot access list includes an unmapped identity.",
    );
    requireImport(
      b.visibility !== "private" || (!b.readers.length && !b.managers.length),
      "Private bot has additional grants.",
    );
  }
  for (const c of data.conversations) {
    requireImport(member.has(c.owner), "A conversation owner is unmapped.");
    unique(c.messages.map((m) => m.id));
    for (let i = 1; i < c.messages.length; i++) {
      requireImport(
        epochMicros(c.messages[i - 1]!.createdAt) <=
          epochMicros(c.messages[i]!.createdAt),
        "Messages must use original chronological order within each conversation.",
      );
    }
    if (c.bot !== null) {
      const b = bots.get(c.bot);
      requireImport(
        b &&
          (b.visibility === "team" ||
            b.owner === c.owner ||
            b.readers.includes(c.owner) ||
            b.managers.includes(c.owner)),
        "A conversation refers to a missing or inaccessible bot.",
      );
    }
  }
  const actual = inventory(data);
  requireImport(
    actual.bots === config.expected.bots &&
      actual.conversations === config.expected.conversations &&
      actual.messages === config.expected.messages,
    "Source counts differ from the reviewed inventory.",
  );
  requireImport(
    actual.bots + actual.conversations > 0,
    "The archive is empty.",
  );
  return member;
}
