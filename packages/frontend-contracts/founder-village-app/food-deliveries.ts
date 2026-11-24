import { z } from "zod";

const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const centsSchema = z.number().int().min(0).max(10_000_000);

export const founderTenantSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
  })
  .strict();

export const founderCompanySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(160),
    legalName: z.string().min(1).max(200).optional(),
    website: z.string().url().optional(),
  })
  .strict();

export const founderBalanceSchema = z
  .object({
    currency: currencySchema,
    balanceCents: z.number().int(),
  })
  .strict();

export const founderProfileSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    fullName: z.string().min(1).max(160),
    email: z.string().email().max(320),
    phone: z.string().min(7).max(40).optional(),
    room: z.string().min(1).max(80).optional(),
    companies: z.array(founderCompanySchema),
    balance: founderBalanceSchema,
  })
  .strict();

export const expenseDirectionSchema = z.enum(["charge", "credit"]);
export const expenseStatusSchema = z.enum(["pending", "posted", "void"]);
export const expenseCategorySchema = z.enum([
  "food_delivery",
  "membership",
  "workspace",
  "other",
]);

export const founderExpenseSchema = z
  .object({
    id: z.string().uuid(),
    direction: expenseDirectionSchema,
    status: expenseStatusSchema,
    category: expenseCategorySchema,
    description: z.string().min(1).max(240),
    amountCents: centsSchema,
    currency: currencySchema,
    incurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const foodDeliveryProviderSchema = z.enum(["ifood", "99food"]);
export const foodDeliveryStatusSchema = z.enum([
  "placed",
  "accepted",
  "preparing",
  "out_for_delivery",
  "delivered",
  "cancelled",
]);

export const foodDeliveryInputSchema = z
  .object({
    provider: foodDeliveryProviderSchema,
    providerOrderId: z.string().trim().min(2).max(80),
    restaurantName: z.string().trim().min(2).max(160),
    deliveryAddress: z.string().trim().min(3).max(240),
    subtotalCents: centsSchema,
    deliveryFeeCents: centsSchema,
    serviceFeeCents: centsSchema,
    expectedAt: z.string().datetime({ offset: true }).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();

export const foodDeliverySchema = z
  .object({
    id: z.string().uuid(),
    provider: foodDeliveryProviderSchema,
    providerOrderId: foodDeliveryInputSchema.shape.providerOrderId,
    restaurantName: foodDeliveryInputSchema.shape.restaurantName,
    deliveryAddress: foodDeliveryInputSchema.shape.deliveryAddress,
    subtotalCents: centsSchema,
    deliveryFeeCents: centsSchema,
    serviceFeeCents: centsSchema,
    totalCents: centsSchema,
    currency: currencySchema,
    status: foodDeliveryStatusSchema,
    expectedAt: foodDeliveryInputSchema.shape.expectedAt,
    notes: foodDeliveryInputSchema.shape.notes,
    expenseId: z.string().uuid(),
    expenseStatus: expenseStatusSchema,
    placedAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const founderTenantsResponseSchema = z.array(founderTenantSchema);
export const founderExpensesResponseSchema = z.array(founderExpenseSchema);
export const foodDeliveriesResponseSchema = z.array(foodDeliverySchema);

export type FounderTenant = z.infer<typeof founderTenantSchema>;
export type FounderCompany = z.infer<typeof founderCompanySchema>;
export type FounderProfile = z.infer<typeof founderProfileSchema>;
export type FounderExpense = z.infer<typeof founderExpenseSchema>;
export type FoodDeliveryInput = z.infer<typeof foodDeliveryInputSchema>;
export type FoodDelivery = z.infer<typeof foodDeliverySchema>;
