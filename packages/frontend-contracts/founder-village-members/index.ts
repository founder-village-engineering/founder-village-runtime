import { z } from "zod";

export const applicationId = "founder-village-members" as const;
export const communityId = "a7c22ce4-dcee-442c-b809-7eb9b14a5d53" as const;

export const whatsappNumberSchema = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
export const profileInputSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    headline: z.string().trim().min(1).max(100).nullable(),
    location: z.string().trim().min(1).max(60).nullable(),
    listed: z.boolean(),
    whatsappNumber: whatsappNumberSchema.nullable(),
  })
  .strict();
export const profileSchema = profileInputSchema.extend({ id: z.uuid() });
export const memberResponseSchema = z.object({
  profile: profileSchema.nullable(),
});

export const directoryQuerySchema = z
  .object({
    q: z.string().trim().max(100).default(""),
    after: z.uuid().optional(),
  })
  .strict();
export const directoryMemberSchema = profileSchema
  .pick({
    id: true,
    name: true,
    headline: true,
    location: true,
  })
  .extend({ whatsappAvailable: z.boolean() });
export const directoryResponseSchema = z.object({
  members: z.array(directoryMemberSchema).max(24),
  next: z.uuid().nullable(),
});
export const contactResponseSchema = z.object({ number: whatsappNumberSchema });
export const deletionResponseSchema = z.object({ deleted: z.literal(true) });

export const paymentMethodSchema = z.enum(["card", "sol", "usdc"]);
export const checkoutStatusSchema = z.enum([
  "pending",
  "paid",
  "expired",
  "reversed",
]);
export const offerSchema = z.object({
  method: paymentMethodSchema,
  amount: z.string().regex(/^\d+(\.\d{1,9})?$/),
  currency: z.enum(["USD", "SOL", "USDC"]),
  test: z.boolean(),
});
export const checkoutSchema = offerSchema.extend({
  id: z.uuid(),
  status: checkoutStatusSchema,
  expiresAt: z.iso.datetime(),
});
export const membershipSchema = z.object({
  tier: z.enum(["free", "paid"]),
  offers: z.array(offerSchema).max(3),
  checkout: checkoutSchema.nullable(),
});
export const checkoutInputSchema = z
  .object({ method: paymentMethodSchema })
  .strict();
export const signatureSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
export const checkInputSchema = z
  .object({ signature: signatureSchema.optional() })
  .strict();
export const checkoutActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stripe"),
    url: z.url({ protocol: /^https$/, hostname: /^checkout\.stripe\.com$/ }),
  }),
  z.object({
    kind: z.literal("solana"),
    url: z.string().regex(/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}\?/),
    network: z.enum(["mainnet-beta", "devnet"]),
  }),
]);
export const checkoutResponseSchema = z.object({
  checkout: checkoutSchema,
  action: checkoutActionSchema.nullable(),
});

export type ProfileInput = z.infer<typeof profileInputSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type DirectoryMember = z.infer<typeof directoryMemberSchema>;
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type Offer = z.infer<typeof offerSchema>;
export type Checkout = z.infer<typeof checkoutSchema>;
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;
