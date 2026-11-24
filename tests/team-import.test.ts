import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveSchema,
  mappingSchema,
  validateArchive,
} from "../scripts/team-import/archive.ts";

export const syntheticArchive = {
  format: "founder-village-grok-import-v1",
  team: "synthetic-workspace",
  bots: [
    {
      id: "sample-bot",
      owner: "sample-author",
      visibility: "selected",
      readers: ["sample-reader"],
      managers: [],
      createdAt: "2026-01-02T03:04:05Z",
      name: "Example Bot",
      description: "Synthetic data only",
      instructions: "Answer product questions.",
      configuration: { skills: ["sample-skill"] },
    },
  ],
  conversations: [
    {
      id: "sample-thread",
      visibility: "private",
      owner: "sample-reader",
      bot: "sample-bot",
      title: "Example conversation",
      createdAt: "2026-01-02T03:04:05Z",
      messages: [
        {
          id: "sample-message",
          role: "user",
          content: "Example question",
          createdAt: "2026-01-02T03:04:06Z",
        },
      ],
    },
  ],
};
export const syntheticMapping = {
  team: "synthetic-workspace",
  tenant: "1a111111-1111-4111-8111-111111111111",
  exportSha256: "0".repeat(64),
  expected: { bots: 1, conversations: 1, messages: 1 },
  members: [
    { source: "sample-author", actor: "fixture|author" },
    { source: "sample-reader", actor: "fixture|reader" },
  ],
};
test("reviewed normalized archive preserves ownership and rejects unsupported or incomplete input", () => {
  const data = archiveSchema.parse(syntheticArchive),
    config = mappingSchema.parse(syntheticMapping);
  assert.equal(validateArchive(data, config).size, 2);
  assert.throws(() =>
    validateArchive(data, { ...config, team: "another-team" }),
  );
  assert.throws(() =>
    validateArchive(data, { ...config, members: config.members.slice(0, 1) }),
  );
  assert.throws(() =>
    validateArchive(data, {
      ...config,
      expected: { ...config.expected, messages: 2 },
    }),
  );
  assert.throws(() =>
    validateArchive(
      { ...data, bots: data.bots.map((b) => ({ ...b, readers: [] })) },
      config,
    ),
  );
  const thread = data.conversations[0]!;
  const original = thread.messages[0]!;
  const outOfOrder = [
    original,
    {
      ...original,
      id: "an-earlier-message",
      createdAt: "2026-01-02T03:04:05.999999Z",
    },
  ];
  assert.throws(() =>
    validateArchive(
      { ...data, conversations: [{ ...thread, messages: outOfOrder }] },
      { ...config, expected: { ...config.expected, messages: 2 } },
    ),
  );
  assert.throws(() =>
    archiveSchema.parse({ ...data, files: [{ name: "attachment" }] }),
  );
  assert.throws(() =>
    archiveSchema.parse({
      ...data,
      conversations: data.conversations.map((c) => ({
        ...c,
        visibility: "group",
      })),
    }),
  );
});
