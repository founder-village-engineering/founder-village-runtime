import { z } from "zod";

export const applicationId = "founder-village-team" as const;
export const teamPageSize = 35;
export type ApplicationId = typeof applicationId;
export const tenantsSchema = z.array(
  z.object({ id: z.uuid(), name: z.string() }),
);
export const pageQuerySchema = z
  .object({ after: z.uuid().optional() })
  .strict();
export const botViewQuerySchema = z.strictObject({
  view: z.literal("directory").optional(),
});
export const botPageQuerySchema = pageQuerySchema.extend(
  botViewQuerySchema.shape,
);
export const messagePageQuerySchema = pageQuerySchema.extend({
  order: z.enum(["oldest", "newest"]).default("oldest"),
});
export const messageContentQuerySchema = z.strictObject({
  offset: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const messageContentChunkSchema = z.object({
  content: z.string(),
  authorName: z.string().nullable(),
  nextOffset: z.number().int().positive().nullable(),
});
const title = z.string().trim().min(1).max(240);
export const botConfigurationSchema = z
  .object({
    model: z.string().max(200).optional(),
    skills: z.array(z.string()).optional(),
    plugins: z.array(z.string()).optional(),
    automations: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    memory: z.string().optional(),
  })
  .strict();
export const botInputSchema = z
  .object({
    name: title,
    description: z.string().max(2000).default(""),
    instructions: z.string().max(10000),
    visibility: z.enum(["private", "team"]).default("private"),
  })
  .strict();
export const botSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  instructions: z.string().nullable(),
  visibility: z.enum(["private", "selected", "team"]),
  configuration: botConfigurationSchema.nullable(),
  canManage: z.boolean(),
  createdAt: z.iso.datetime(),
});
export const conversationInputSchema = z
  .object({ title, botId: z.uuid().nullable().optional() })
  .strict();
export const conversationSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  botId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export const messageInputSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(12000)
      .refine((v) => v.trim().length > 0),
  })
  .strict();
export const messageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  authorName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  position: z.number().int().positive(),
  nextOffset: z.number().int().positive().optional(),
});
export const replyInputSchema = z.object({ messageId: z.uuid() }).strict();
const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), next: z.uuid().nullable() });
export const botsSchema = page(botSchema);
export const conversationsSchema = page(conversationSchema);
export const messagesSchema = page(messageSchema);
export type Bot = z.infer<typeof botSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type Message = z.infer<typeof messageSchema>;
export const capabilitiesSchema = z.object({ repliesAvailable: z.boolean() });

export const botUpdateSchema = botInputSchema.omit({ visibility: true });
