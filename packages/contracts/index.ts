import { z } from "zod";
export const uuid = z.string().uuid();
export const recordInput = z
  .object({
    content: z.string().trim().min(1).max(4000),
    embedding: z
      .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
      .refine((v) => v.some((n) => n !== 0), "zero vector is not searchable"),
  })
  .strict();
export const vectorQuery = z
  .object({
    embedding: recordInput.shape.embedding,
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();
export const dnsRecord = z
  .object({
    type: z.enum(["A", "AAAA", "CNAME", "TXT"]),
    name: z
      .string()
      .min(3)
      .max(253)
      .regex(/^[a-z0-9.-]+$/),
    content: z.string().min(1).max(2048),
    proxied: z.boolean().default(false),
    ttl: z.number().int().min(60).max(86400).default(300),
  })
  .strict();
export const actions = [
  "backup.capture",
  "backup.verify",
  "backup.restore-drill",
  "deploy.release",
  "deploy.rollback",
  "dns.apply",
  "wireguard.revoke",
  "jobs.retry",
  "audit.archive",
  "schedules.manage",
] as const;
export const operation = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("backup.capture"),
    parameters: z
      .object({ type: z.enum(["full", "diff"]).default("diff") })
      .strict(),
  }),
  z.object({
    action: z.literal("backup.verify"),
    parameters: z.object({}).strict(),
  }),
  z.object({
    action: z.literal("backup.restore-drill"),
    parameters: z.object({}).strict(),
  }),
  z.object({
    action: z.literal("deploy.release"),
    parameters: z
      .object({ release: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict(),
  }),
  z.object({
    action: z.literal("deploy.rollback"),
    parameters: z.object({}).strict(),
  }),
  z.object({
    action: z.literal("dns.apply"),
    parameters: z.object({ planId: uuid }).strict(),
  }),
  z.object({
    action: z.literal("wireguard.revoke"),
    parameters: z
      .object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) })
      .strict(),
  }),
  z.object({
    action: z.literal("jobs.retry"),
    parameters: z
      .object({
        application: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
        jobId: uuid,
      })
      .strict(),
  }),
  z.object({
    action: z.literal("audit.archive"),
    parameters: z.object({}).strict(),
  }),
  z.object({
    action: z.literal("schedules.manage"),
    parameters: z
      .object({
        application: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
        name: z.string().regex(/^[a-z0-9-]{1,63}$/),
        intervalSeconds: z.number().int().min(60).max(2592000),
      })
      .strict(),
  }),
]);
export type Operation = z.infer<typeof operation>;
export const envelope = z
  .object({
    version: z.literal(1),
    application: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    jobId: uuid,
    tenantId: uuid,
    correlationId: uuid,
    actor: z.string().min(1).max(512),
  })
  .strict();
export type Envelope = z.infer<typeof envelope>;
export const adminActions = [
  ...actions,
  "dashboard.read",
  "dns.plan",
  "admins.manage",
] as const;
export const scheduleInput = z
  .object({
    name: z.string().regex(/^[a-z0-9-]{1,63}$/),
    intervalSeconds: z.number().int().min(60).max(2592000),
  })
  .strict();
