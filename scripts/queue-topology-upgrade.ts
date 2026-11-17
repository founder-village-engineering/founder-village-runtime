import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import amqp from "amqplib";
import { applications } from "../packages/database/applications.ts";
import { secret } from "../packages/database/index.ts";
import { broker } from "../packages/queue/index.ts";
if (secret("FV_ENV") !== "local")
  throw new Error(
    "this repair is restricted to synthetic local fixtures; use a versioned/drained migration for live queues",
  );
const project = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .parse(secret("COMPOSE_PROJECT_NAME"));
const listed = await promisify(execFile)(
  "docker",
  [
    "exec",
    `${project}-rabbitmq-1`,
    "rabbitmqctl",
    "list_queues",
    "-p",
    "fv",
    "name",
    "messages",
    "consumers",
    "--formatter=json",
  ],
  { timeout: 30000 },
);
const queues = z
  .array(
    z.object({ name: z.string(), messages: z.number(), consumers: z.number() }),
  )
  .parse(JSON.parse(listed.stdout));
const names = new Set(applications.map((a) => `fv.jobs.${a.id}`));
const owned = queues.filter((q) => names.has(q.name));
if (owned.some((q) => q.messages !== 0 || q.consumers !== 0))
  throw new Error(
    "stop/drain owned workers and queues before topology migration; no messages were removed",
  );
const connection = await amqp.connect(secret("AMQP_URL"));
connection.on("error", () => {});
try {
  const channel = await connection.createChannel();
  for (const q of owned) {
    const current = await channel.checkQueue(q.name);
    if (current.messageCount || current.consumerCount)
      throw new Error(
        "local queue changed after inspection; stop publishers before retrying",
      );
    // Quorum queues reject both conditional-delete flags. This utility is local
    // only and requires stopped publishers plus two independent empty checks.
    await channel.deleteQueue(q.name);
  }
} finally {
  await connection.close();
}
for (const app of applications) {
  const current = await broker(secret("AMQP_URL"), app.id);
  try {
    await current.channel.unbindQueue(`fv.dead.${app.id}`, "fv.dead", "dead");
  } finally {
    await current.connection.close();
  }
}
console.log(
  JSON.stringify({
    event: "queue.topology.verified",
    applications: applications.map((a) => a.id),
    messagesRemoved: 0,
  }),
);
await writeFile(
  `.state/${secret("FV_ENV")}/queue-topology.json`,
  JSON.stringify({
    version: 2,
    applications: applications.map((a) => a.id),
    messagesRemoved: 0,
  }),
  { mode: 0o600 },
);
