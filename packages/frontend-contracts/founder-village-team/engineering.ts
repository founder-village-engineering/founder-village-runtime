import { z } from "zod";

export const engineeringStatuses = ["backlog", "in_progress", "done"] as const;
export const engineeringStatusSchema = z.enum(engineeringStatuses);
export const engineeringInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    detail: z.string().trim().max(1400).default(""),
  })
  .strict();
const revision = z.number().int().positive().max(2_147_483_647);
export const engineeringUpdateSchema = z
  .object({ status: engineeringStatusSchema, revision })
  .strict();
export const engineeringItemSchema = engineeringInputSchema.extend({
  id: z.uuid(),
  status: engineeringStatusSchema,
  revision,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const engineeringPageSchema = z.object({
  items: z.array(engineeringItemSchema).max(24),
  next: z.uuid().nullable(),
});

export type EngineeringInput = z.infer<typeof engineeringInputSchema>;
export type EngineeringStatus = z.infer<typeof engineeringStatusSchema>;
export type EngineeringItem = z.infer<typeof engineeringItemSchema>;
