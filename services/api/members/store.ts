import { randomUUID } from "node:crypto";
import type pg from "pg";
import { denied } from "../../../packages/auth/index.ts";
import { transaction } from "../../../packages/database/index.ts";
import {
  communityId,
  type Checkout,
  type Offer,
  type PaymentMethod,
  type ProfileInput,
} from "../../../packages/frontend-contracts/founder-village-members/index.ts";

export type Order = {
  id: string;
  request_key: string;
  method: PaymentMethod;
  status: Checkout["status"];
  amount_units: string;
  test: boolean;
  recipient: string | null;
  reference: string | null;
  stripe_session: string | null;
  payment_id: string | null;
  return_origin: string | null;
  created_at: Date;
  expires_at: Date;
};

export function memberContext<T>(
  database: pg.Pool,
  actor: string,
  run: (client: pg.PoolClient) => Promise<T>,
) {
  return transaction(database, async (client) => {
    await client.query(
      "SELECT set_config('fv.actor',$1,true),set_config('fv.tenant',$2,true)",
      [actor, communityId],
    );
    return run(client);
  });
}

export function settlementContext<T>(
  database: pg.Pool,
  provider: "stripe" | "solana",
  run: (client: pg.PoolClient) => Promise<T>,
) {
  return transaction(database, async (client) => {
    await client.query("SELECT set_config('fv.members_settlement',$1,true)", [
      provider,
    ]);
    return run(client);
  });
}

export async function ownProfile(client: pg.PoolClient, lock = false) {
  const { rows } = await client.query<ProfileInput & { id: string }>(
    `SELECT id,display_name AS name,headline,location,listed,whatsapp_number AS "whatsappNumber"
     FROM app.member_profiles${lock ? " FOR UPDATE" : ""}`,
  );
  return rows[0] ?? null;
}

export async function requireProfile(client: pg.PoolClient, lock = false) {
  const profile = await ownProfile(client, lock);
  if (!profile) denied(403);
  return profile;
}

export async function saveProfile(
  client: pg.PoolClient,
  actor: string,
  input: ProfileInput,
  create: boolean,
) {
  const fields = [
    input.name,
    input.headline,
    input.location,
    input.listed,
    input.whatsappNumber,
  ];
  if (create) {
    await client.query(
      `INSERT INTO app.member_profiles (display_name,headline,location,listed,whatsapp_number,id,tenant_id,actor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,actor) DO NOTHING`,
      [...fields, randomUUID(), communityId, actor],
    );
  } else {
    await client.query(
      `UPDATE app.member_profiles SET display_name=$1,headline=$2,location=$3,listed=$4,whatsapp_number=$5`,
      fields,
    );
  }
  return requireProfile(client);
}

export function offer(
  method: PaymentMethod,
  amountUnits: bigint,
  test: boolean,
): Offer {
  const digits = method === "card" ? 2 : method === "sol" ? 9 : 6;
  const fixed = amountUnits.toString().padStart(digits + 1, "0");
  const cents = fixed.slice(-digits);
  const amount = `${fixed.slice(0, -digits)}.${cents}`;
  return {
    method,
    amount: method === "card" ? amount : amount.replace(/\.?0+$/, ""),
    currency: method === "card" ? "USD" : method === "sol" ? "SOL" : "USDC",
    test,
  };
}

export function checkout(order: Order): Checkout {
  return {
    ...offer(order.method, BigInt(order.amount_units), order.test),
    id: order.id,
    expiresAt: order.expires_at.toISOString(),
    status: order.status,
  };
}

export async function findOrder(client: pg.PoolClient, id: string) {
  const result = await client.query<Order>(
    "SELECT * FROM app.member_checkouts WHERE id=$1",
    [id],
  );
  return result.rows[0];
}

export async function saveSettlement(
  client: pg.PoolClient,
  order: Order,
  status: "paid" | "reversed",
  paymentId: string,
) {
  // Reversal is terminal. A slow completion or repeated provider callback cannot restore it.
  await client.query(
    `UPDATE app.member_checkouts SET status=$2,payment_id=$3
     WHERE id=$1 AND status <> 'reversed' AND (payment_id IS NULL OR payment_id=$3)`,
    [order.id, status, paymentId],
  );
}

export async function expireOrder(client: pg.PoolClient, id: string) {
  await client.query(
    "UPDATE app.member_checkouts SET status='expired' WHERE id=$1 AND status='pending'",
    [id],
  );
}
