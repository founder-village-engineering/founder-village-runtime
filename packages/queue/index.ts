import amqp, { type ConfirmChannel, type ChannelModel } from "amqplib";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import { envelope, type Envelope } from "../contracts/index.ts";
import { transaction } from "../database/index.ts";
import { schedule } from "./scheduler.ts";
export const queueName = "fv.jobs.founder-village",
  deadQueue = "fv.dead.founder-village";
class InvalidJob extends Error {}
export async function broker(
  url: string,
  application = "founder-village",
): Promise<{ connection: ChannelModel; channel: ConfirmChannel }> {
  const queueName = `fv.jobs.${application}`,
    deadQueue = `fv.dead.${application}`;
  const connection = await amqp.connect(url, { timeout: 5000 });
  connection.on("error", () => {});
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange("fv.dead", "direct", { durable: true });
  await channel.assertQueue(deadQueue, {
    durable: true,
    arguments: { "x-queue-type": "quorum" },
  });
  await channel.bindQueue(deadQueue, "fv.dead", application);
  await channel.assertQueue(queueName, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
      "x-dead-letter-exchange": "fv.dead",
      "x-dead-letter-routing-key": application,
      "x-delivery-limit": 10,
      "x-max-length": 100000,
      "x-overflow": "reject-publish",
    },
  });
  await channel.prefetch(4);
  return { connection, channel };
}
export async function relay(
  db: pg.Pool,
  ch: ConfirmChannel,
  application = "founder-village",
): Promise<number> {
  return transaction(db, async (c) => {
    const { rows } = await c.query<{
      id: string;
      tenant_id: string;
      actor: string;
      correlation_id: string;
    }>(
      "SELECT id,tenant_id,actor,correlation_id FROM app.outbox WHERE state='pending' AND available_at<=now() ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 20",
    );
    for (const row of rows) {
      const body: Envelope = {
        version: 1,
        application,
        jobId: row.id,
        tenantId: row.tenant_id,
        actor: row.actor,
        correlationId: row.correlation_id,
      };
      await new Promise<void>((resolve, reject) => {
        let returned = false;
        const onReturn = (message: { properties: { messageId?: string } }) => {
          if (message.properties.messageId === row.id) returned = true;
        };
        ch.on("return", onReturn);
        try {
          ch.sendToQueue(
            `fv.jobs.${application}`,
            Buffer.from(JSON.stringify(body)),
            {
              persistent: true,
              mandatory: true,
              contentType: "application/json",
              messageId: row.id,
            },
            (error) => {
              ch.off("return", onReturn);
              if (error || returned)
                reject(error ?? new Error("unroutable_job"));
              else resolve();
            },
          );
        } catch (error) {
          ch.off("return", onReturn);
          reject(error);
        }
      });
      await c.query(
        "UPDATE app.outbox SET state='published',published_at=now() WHERE id=$1",
        [row.id],
      );
    }
    return rows.length;
  });
}
export async function processJob(
  db: pg.Pool,
  value: unknown,
  application = "founder-village",
): Promise<void> {
  const message = envelope.parse(value);
  if (message.application !== application)
    throw new InvalidJob("application provenance mismatch");
  await transaction(db, async (c) => {
    const { rows } = await c.query<{
      state: string;
      tenant_id: string;
      actor: string;
      correlation_id: string;
      record_id: string;
      kind: string;
    }>("SELECT * FROM app.outbox WHERE id=$1 FOR UPDATE", [message.jobId]);
    const row = rows[0];
    if (
      !row ||
      row.tenant_id !== message.tenantId ||
      row.actor !== message.actor ||
      row.correlation_id !== message.correlationId
    )
      throw new InvalidJob("invalid provenance");
    // Only a confirmed publication may execute. Delayed retries and terminal jobs
    // must not be revived by stale broker deliveries.
    if (row.state !== "published") return;
    if (!["record.process", "maintenance.sweep"].includes(row.kind))
      throw new InvalidJob("unsupported job kind");
    const effect = await c.query(
      "INSERT INTO app.job_effects(job_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING job_id",
      [message.jobId],
    );
    if (!effect.rowCount) return;
    await c.query(
      "SELECT set_config('fv.tenant',$1,true),set_config('fv.actor',$2,true)",
      [row.tenant_id, row.actor],
    );
    if (row.kind === "record.process") {
      const membership = await c.query<{ allowed: boolean }>(
        "SELECT app.is_member($1::uuid) AS allowed",
        [row.tenant_id],
      );
      if (!membership.rows[0]?.allowed)
        throw new Error("actor membership revoked");
    }
    if (row.kind === "record.process")
      await c.query(
        "UPDATE app.records SET result=upper(content),updated_at=now() WHERE id=$1 AND tenant_id=$2",
        [row.record_id, row.tenant_id],
      );
    await c.query(
      "UPDATE app.outbox SET state='completed',completed_at=now() WHERE id=$1",
      [message.jobId],
    );
  });
}
export async function retry(
  db: pg.Pool,
  value: unknown,
  application = "founder-village",
) {
  const message = envelope.parse(value);
  if (message.application !== application)
    throw new InvalidJob("application provenance mismatch");
  // Recheck provenance and state atomically after processJob rolled back. A
  // rejected message must never consume another job's retry budget.
  await db.query(
    "UPDATE app.outbox SET attempts=attempts+1,state=CASE WHEN attempts>=4 THEN 'dead' ELSE 'pending' END,available_at=now()+least(300,power(2,attempts+1)) * interval '1 second',last_error='processing_failed' WHERE id=$1 AND tenant_id=$2 AND actor=$3 AND correlation_id=$4 AND state='published'",
    [message.jobId, message.tenantId, message.actor, message.correlationId],
  );
}
export async function worker(
  db: pg.Pool,
  url: string,
  signal: AbortSignal,
  application = "founder-village",
  onReady: () => void = () => {},
) {
  const { connection, channel } = await broker(url, application);
  let closed = false;
  connection.on("close", () => {
    closed = true;
  });
  const active = new Set<Promise<void>>();
  const { consumerTag } = await channel.consume(
    `fv.jobs.${application}`,
    (msg) => {
      if (!msg) {
        closed = true;
        return;
      }
      const task = (async () => {
        let parsed: Envelope;
        try {
          if (msg.content.length > 4096) throw new Error();
          parsed = envelope.parse(JSON.parse(msg.content.toString()));
        } catch {
          channel.nack(msg, false, false);
          return;
        }
        try {
          await processJob(db, parsed, application);
          channel.ack(msg);
        } catch (error) {
          if (error instanceof InvalidJob) {
            channel.nack(msg, false, false);
            return;
          }
          try {
            await retry(db, parsed, application);
            channel.ack(msg);
          } catch {
            channel.nack(msg, false, true);
          }
        }
      })();
      active.add(task);
      void task
        .catch(() => {
          closed = true;
        })
        .finally(() => active.delete(task));
    },
  );
  try {
    onReady();
    while (!signal.aborted && !closed) {
      await schedule(db);
      await relay(db, channel, application);
      await delay(500, undefined, { signal }).catch(() => {});
    }
    if (closed && !signal.aborted) throw new Error("broker connection lost");
  } finally {
    if (!closed) {
      await channel.cancel(consumerTag);
      await Promise.allSettled([...active]);
      await connection.close();
    }
  }
}
