import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { bearer, hash } from "../../packages/auth/index.ts";
import {
  foodDeliveriesResponseSchema,
  foodDeliveryInputSchema,
  foodDeliverySchema,
  founderExpenseSchema,
  founderExpensesResponseSchema,
  founderProfileSchema,
  founderTenantsResponseSchema,
  foundersApplicationId,
  type FoodDelivery,
  type FounderExpense,
} from "../../packages/frontend-contracts/founder-food-deliveries/index.ts";
import { selectApplication } from "../../packages/database/applications.ts";
import { tenant, transaction } from "../../packages/database/index.ts";
import { uuid } from "../../packages/contracts/index.ts";

type FounderRow = {
  id: string;
  tenant_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  room: string | null;
};

type CompanyRow = {
  id: string;
  name: string;
  legal_name: string | null;
  website: string | null;
};

type ExpenseRow = {
  id: string;
  direction: string;
  status: string;
  category: string;
  description: string;
  amount_cents: number;
  currency: string;
  incurred_at: Date | string;
};

type FoodDeliveryRow = {
  id: string;
  provider: string;
  provider_order_id: string;
  restaurant_name: string;
  delivery_address: string;
  subtotal_cents: number;
  delivery_fee_cents: number;
  service_fee_cents: number;
  total_cents: number;
  currency: string;
  status: string;
  expected_at: Date | string | null;
  notes: string | null;
  expense_id: string;
  expense_status: string;
  placed_at: Date | string;
  created_at: Date | string;
};

const deliverySelection = `
  SELECT d.id,d.provider,d.provider_order_id,d.restaurant_name,
         d.delivery_address,d.subtotal_cents,d.delivery_fee_cents,
         d.service_fee_cents,d.total_cents,d.currency,d.status,d.expected_at,
         d.notes,d.expense_id,e.status AS expense_status,d.placed_at,d.created_at
  FROM app.food_deliveries d
  JOIN app.expenses e ON e.id=d.expense_id`;

function selectedDatabase(
  databases: Record<string, pg.Pool>,
  request: FastifyRequest,
): pg.Pool {
  if (request.headers["x-application-id"] !== foundersApplicationId)
    throw Object.assign(new Error("founders application required"), {
      statusCode: 400,
    });
  return selectApplication(databases, foundersApplicationId);
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("invalid database time");
  return date.toISOString();
}

function mapExpense(row: ExpenseRow): FounderExpense {
  return founderExpenseSchema.parse({
    id: row.id,
    direction: row.direction,
    status: row.status,
    category: row.category,
    description: row.description,
    amountCents: row.amount_cents,
    currency: row.currency,
    incurredAt: iso(row.incurred_at),
  });
}

function mapDelivery(row: FoodDeliveryRow): FoodDelivery {
  return foodDeliverySchema.parse({
    id: row.id,
    provider: row.provider,
    providerOrderId: row.provider_order_id,
    restaurantName: row.restaurant_name,
    deliveryAddress: row.delivery_address,
    subtotalCents: row.subtotal_cents,
    deliveryFeeCents: row.delivery_fee_cents,
    serviceFeeCents: row.service_fee_cents,
    totalCents: row.total_cents,
    currency: row.currency,
    status: row.status,
    expectedAt: row.expected_at ? iso(row.expected_at) : undefined,
    notes: row.notes ?? undefined,
    expenseId: row.expense_id,
    expenseStatus: row.expense_status,
    placedAt: iso(row.placed_at),
    createdAt: iso(row.created_at),
  });
}

async function currentFounder(
  client: pg.PoolClient,
  tenantId: string,
): Promise<FounderRow> {
  const result = await client.query<FounderRow>(
    `SELECT id,tenant_id,full_name,email,phone,room
     FROM app.members
     WHERE id=app.current_member_id($1::uuid)`,
    [tenantId],
  );
  if (!result.rows[0])
    throw Object.assign(new Error("founder profile required"), {
      statusCode: 403,
    });
  return result.rows[0];
}

export function registerFoodDeliveryRoutes(
  app: FastifyInstance,
  databases: Record<string, pg.Pool>,
): void {
  app.get("/food-deliveries/tenants", async (request) => {
    const database = selectedDatabase(databases, request);
    const who = await bearer(request);
    return transaction(database, async (client) => {
      await client.query("SELECT set_config('fv.actor',$1,true)", [who.actor]);
      const result = await client.query<{ id: string; name: string }>(
        "SELECT id,name FROM app.my_tenants() ORDER BY name,id",
      );
      return founderTenantsResponseSchema.parse(result.rows);
    });
  });

  app.get("/founders/me", async (request) => {
    const database = selectedDatabase(databases, request);
    const who = await bearer(request);
    const tenantId = uuid.parse(request.headers["x-tenant-id"]);
    return tenant(database, who.actor, tenantId, async (client) => {
      const founder = await currentFounder(client, tenantId);
      const [companies, balance] = await Promise.all([
        client.query<CompanyRow>(
          `SELECT id,name,legal_name,website
           FROM app.companies
           WHERE founder_id=$1 AND active
           ORDER BY name,id`,
          [founder.id],
        ),
        client.query<{ balance_cents: string }>(
          `SELECT COALESCE(SUM(
             CASE direction WHEN 'charge' THEN amount_cents ELSE -amount_cents END
           ),0)::bigint AS balance_cents
           FROM app.expenses
           WHERE founder_id=$1 AND status='posted' AND currency='BRL'`,
          [founder.id],
        ),
      ]);
      return founderProfileSchema.parse({
        id: founder.id,
        tenantId: founder.tenant_id,
        fullName: founder.full_name,
        email: founder.email,
        phone: founder.phone ?? undefined,
        room: founder.room ?? undefined,
        companies: companies.rows.map((company) => ({
          id: company.id,
          name: company.name,
          legalName: company.legal_name ?? undefined,
          website: company.website ?? undefined,
        })),
        balance: {
          currency: "BRL",
          balanceCents: Number(balance.rows[0]?.balance_cents ?? 0),
        },
      });
    });
  });

  app.get("/expenses", async (request) => {
    const database = selectedDatabase(databases, request);
    const who = await bearer(request);
    const tenantId = uuid.parse(request.headers["x-tenant-id"]);
    return tenant(database, who.actor, tenantId, async (client) => {
      const founder = await currentFounder(client, tenantId);
      const result = await client.query<ExpenseRow>(
        `SELECT id,direction,status,category,description,amount_cents,currency,incurred_at
         FROM app.expenses
         WHERE founder_id=$1
         ORDER BY incurred_at DESC,id
         LIMIT 100`,
        [founder.id],
      );
      return founderExpensesResponseSchema.parse(result.rows.map(mapExpense));
    });
  });

  app.get("/food-deliveries", async (request) => {
    const database = selectedDatabase(databases, request);
    const who = await bearer(request);
    const tenantId = uuid.parse(request.headers["x-tenant-id"]);
    return tenant(database, who.actor, tenantId, async (client) => {
      const founder = await currentFounder(client, tenantId);
      const result = await client.query<FoodDeliveryRow>(
        `${deliverySelection}
         WHERE d.founder_id=$1
         ORDER BY d.placed_at DESC,d.id
         LIMIT 100`,
        [founder.id],
      );
      return foodDeliveriesResponseSchema.parse(result.rows.map(mapDelivery));
    });
  });

  app.post("/food-deliveries", async (request, reply) => {
    const database = selectedDatabase(databases, request);
    const who = await bearer(request);
    const tenantId = uuid.parse(request.headers["x-tenant-id"]);
    const key = uuid.parse(request.headers["idempotency-key"]);
    const input = foodDeliveryInputSchema.parse(request.body);
    const totalCents =
      input.subtotalCents + input.deliveryFeeCents + input.serviceFeeCents;
    if (totalCents <= 0 || totalCents > 10_000_000)
      throw Object.assign(new Error("food delivery total is invalid"), {
        statusCode: 400,
      });
    const fingerprint = hash(JSON.stringify(input));
    const result = await tenant(
      database,
      who.actor,
      tenantId,
      async (client) => {
        const founder = await currentFounder(client, tenantId);
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`${tenantId}:${who.actor}:food-delivery:${key}`],
        );
        const previous = await client.query<{
          request_hash: string;
          delivery_id: string;
        }>(
          `SELECT request_hash,delivery_id
           FROM app.food_delivery_request_keys
           WHERE tenant_id=$1 AND actor=$2 AND key=$3`,
          [tenantId, who.actor, key],
        );
        if (previous.rows[0]) {
          if (previous.rows[0].request_hash !== fingerprint)
            throw Object.assign(new Error("idempotency conflict"), {
              statusCode: 409,
            });
          const replay = await client.query<FoodDeliveryRow>(
            `${deliverySelection} WHERE d.id=$1`,
            [previous.rows[0].delivery_id],
          );
          if (!replay.rows[0]) throw new Error("idempotent delivery missing");
          return { delivery: mapDelivery(replay.rows[0]), replayed: true };
        }
        const id = randomUUID();
        try {
          await client.query(
            `INSERT INTO app.food_deliveries(
               id,tenant_id,founder_id,provider,provider_order_id,
               restaurant_name,delivery_address,subtotal_cents,
               delivery_fee_cents,service_fee_cents,total_cents,currency,
               status,expected_at,notes,created_by
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'BRL','placed',$12,$13,$14)`,
            [
              id,
              tenantId,
              founder.id,
              input.provider,
              input.providerOrderId,
              input.restaurantName,
              input.deliveryAddress,
              input.subtotalCents,
              input.deliveryFeeCents,
              input.serviceFeeCents,
              totalCents,
              input.expectedAt ?? null,
              input.notes ?? null,
              who.actor,
            ],
          );
        } catch (error) {
          if ((error as { code?: string }).code === "23505")
            throw Object.assign(new Error("provider order already tracked"), {
              statusCode: 409,
            });
          throw error;
        }
        await client.query(
          `INSERT INTO app.food_delivery_request_keys(
             tenant_id,actor,key,request_hash,delivery_id
           ) VALUES($1,$2,$3,$4,$5)`,
          [tenantId, who.actor, key, fingerprint, id],
        );
        const created = await client.query<FoodDeliveryRow>(
          `${deliverySelection} WHERE d.id=$1`,
          [id],
        );
        if (!created.rows[0]) throw new Error("created food delivery missing");
        return { delivery: mapDelivery(created.rows[0]), replayed: false };
      },
    );
    return reply.code(result.replayed ? 200 : 201).send(result.delivery);
  });
}
