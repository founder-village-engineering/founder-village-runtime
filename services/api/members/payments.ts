import { randomUUID } from "node:crypto";
import { address } from "@solana/addresses";
import type pg from "pg";
import type Stripe from "stripe";
import { z } from "zod";
import { denied } from "../../../packages/auth/index.ts";
import { frontends } from "../../../packages/frontends/index.ts";
import {
  applicationId,
  type CheckoutResponse,
  type Membership,
  type Offer,
  type PaymentMethod,
} from "../../../packages/frontend-contracts/founder-village-members/index.ts";
import { failure } from "../../../packages/observability/index.ts";
import { newReference, solanaAction, SolanaPayments } from "./solana.ts";
import { StripePayments, matchesSession, sessionPayment } from "./stripe.ts";
import {
  checkout,
  expireOrder,
  findOrder,
  memberContext,
  offer,
  requireProfile,
  saveSettlement,
  settlementContext,
  type Order,
} from "./store.ts";

const paymentConfig = z.object({
  MEMBERS_PRICE_USD_CENTS: z.coerce
    .number()
    .int()
    .min(50)
    .max(9_999_999)
    .optional(),
  MEMBERS_STRIPE_KEY: z.string().min(8).optional(),
  MEMBERS_STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
  MEMBERS_SOLANA_RECIPIENT: z.string().optional(),
  MEMBERS_SOLANA_RPC_URL: z.url({ protocol: /^https$/ }).optional(),
  MEMBERS_SOL_LAMPORTS: z
    .string()
    .regex(/^[1-9]\d{0,12}$/)
    .optional(),
});

function configuration() {
  // Parse only named settings and keep provider values out of errors and logs.
  const result = paymentConfig.safeParse(process.env);
  if (!result.success) throw new Error("invalid members payment settings");
  const env = result.data;
  const test = process.env.FV_ENV !== "production";
  const frontend = frontends.find((entry) => entry.id === applicationId);
  if (!frontend) throw new Error("members frontend registration missing");
  const origin =
    process.env.FV_ENV === "local"
      ? frontend.localOrigins.find((value) =>
          value.startsWith("http://127.0.0.1:"),
        )!
      : frontend.productionOrigin;
  const price = env.MEMBERS_PRICE_USD_CENTS;
  if (
    (env.MEMBERS_STRIPE_KEY || env.MEMBERS_STRIPE_WEBHOOK_SECRET) &&
    (!price ||
      !env.MEMBERS_STRIPE_KEY?.match(
        test ? /^(sk|rk)_test_/ : /^(sk|rk)_live_/,
      ) ||
      !env.MEMBERS_STRIPE_WEBHOOK_SECRET)
  ) {
    throw new Error("incomplete members Stripe settings");
  }
  if (
    (env.MEMBERS_SOLANA_RECIPIENT ||
      env.MEMBERS_SOLANA_RPC_URL ||
      env.MEMBERS_SOL_LAMPORTS) &&
    (!price || !env.MEMBERS_SOLANA_RECIPIENT || !env.MEMBERS_SOLANA_RPC_URL)
  ) {
    throw new Error("incomplete members Solana settings");
  }
  const stripe =
    env.MEMBERS_STRIPE_KEY && env.MEMBERS_STRIPE_WEBHOOK_SECRET
      ? new StripePayments(
          env.MEMBERS_STRIPE_KEY,
          env.MEMBERS_STRIPE_WEBHOOK_SECRET,
          test,
          origin,
        )
      : undefined;
  let solana: SolanaPayments | undefined;
  if (env.MEMBERS_SOLANA_RECIPIENT && env.MEMBERS_SOLANA_RPC_URL) {
    try {
      const url = new URL(env.MEMBERS_SOLANA_RPC_URL);
      if (url.username || url.password || url.hash) throw new Error();
      solana = new SolanaPayments(
        url.href,
        test,
        address(env.MEMBERS_SOLANA_RECIPIENT),
      );
    } catch {
      throw new Error("invalid members Solana provider settings");
    }
  }
  const amounts = {
    card: stripe && price ? BigInt(price) : undefined,
    sol:
      solana && env.MEMBERS_SOL_LAMPORTS
        ? BigInt(env.MEMBERS_SOL_LAMPORTS)
        : undefined,
    usdc: solana && price ? BigInt(price) * 10_000n : undefined,
  };
  return { amounts, stripe, solana, test };
}

export class MemberPayments {
  private readonly settings = configuration();
  private readonly offers: Offer[] = (["card", "sol", "usdc"] as const).flatMap(
    (method) => {
      const amount = this.settings.amounts[method];
      return amount ? [offer(method, amount, this.settings.test)] : [];
    },
  );

  constructor(private readonly database: pg.Pool) {}

  async membership(actor: string): Promise<Membership> {
    return memberContext(this.database, actor, async (client) => {
      await requireProfile(client);
      const {
        rows: [latest],
      } = await client.query<Order>(
        `SELECT * FROM app.member_checkouts WHERE test=$1
         ORDER BY (status='paid') DESC,(status='pending') DESC,created_at DESC,id DESC LIMIT 1`,
        [this.settings.test],
      );
      return {
        tier: latest?.status === "paid" ? "paid" : "free",
        checkout: latest ? checkout(latest) : null,
        offers: this.offers,
      };
    });
  }

  async start(
    actor: string,
    method: PaymentMethod,
    key: string,
    origin?: string,
  ) {
    const order = await memberContext(this.database, actor, async (client) => {
      const profile = await requireProfile(client, true);
      const {
        rows: [previous],
      } = await client.query<Order>(
        "SELECT * FROM app.member_checkouts WHERE request_key=$1",
        [key],
      );
      if (previous) {
        if (previous.method !== method) denied(409);
        return previous;
      }
      const {
        rows: [active],
      } = await client.query<Order>(
        `SELECT * FROM app.member_checkouts WHERE (status='paid' AND test=$1) OR status='pending' LIMIT 1`,
        [this.settings.test],
      );
      if (active) denied(409);
      const units = this.settings.amounts[method];
      if (!units) denied(503);
      const card = method === "card";
      const returnOrigin = card
        ? this.settings.stripe?.registeredOrigin(origin)
        : undefined;
      const expiresAt = new Date(
        Math.floor(Date.now() / 1000) * 1000 + (card ? 35 : 20) * 60_000,
      );
      const {
        rows: [created],
      } = await client.query<Order>(
        `INSERT INTO app.member_checkouts(id,member_id,request_key,method,amount_units,test,recipient,reference,expires_at,return_origin)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          randomUUID(),
          profile.id,
          key,
          method,
          units.toString(),
          this.settings.test,
          card ? null : this.settings.solana!.recipient,
          card ? null : newReference(),
          expiresAt,
          returnOrigin ?? null,
        ],
      );
      return created!;
    });
    return this.open(actor, order.id);
  }

  private async memberOrder(actor: string, id: string) {
    return memberContext(this.database, actor, async (client) => {
      await requireProfile(client);
      const order = await findOrder(client, id);
      if (!order) denied(404);
      return order;
    });
  }

  async open(actor: string, id: string): Promise<CheckoutResponse> {
    const order = await this.memberOrder(actor, id);
    if (order.status !== "pending")
      return { checkout: checkout(order), action: null };
    if (order.method !== "card") {
      if (!this.settings.solana || this.settings.solana.test !== order.test)
        denied(503);
      await this.settings.solana.verifyNetwork();
      return {
        checkout: checkout(order),
        action:
          Date.now() < order.expires_at.valueOf() ? solanaAction(order) : null,
      };
    }
    const stripe = this.settings.stripe;
    if (!stripe || stripe.test !== order.test) denied(503);
    if (
      !order.stripe_session &&
      order.expires_at.valueOf() - Date.now() < 31 * 60_000
    ) {
      // Stripe requires at least 30 minutes at creation. Keep the order locked
      // until its deadline in case an earlier request reached Stripe before a timeout.
      return { checkout: checkout(await this.check(actor, id)), action: null };
    }
    const session = order.stripe_session
      ? await stripe.retrieve(order.stripe_session)
      : await stripe.create(order);
    const updated = await this.applySession(order, session);
    const action =
      updated.status === "pending" && session.status === "open"
        ? stripe.action(session)
        : null;
    return { checkout: checkout(updated), action };
  }

  async check(actor: string, id: string, signature?: string): Promise<Order> {
    const order = await this.memberOrder(actor, id);
    if (order.method !== "card") {
      if (
        order.status === "pending" ||
        (order.status === "expired" && signature)
      )
        await this.reconcileSolana(order, signature);
      return this.memberOrder(actor, id);
    }
    if (signature) denied(400);
    if (order.status !== "pending") return order;
    if (order.stripe_session) {
      const stripe = this.settings.stripe;
      if (!stripe || stripe.test !== order.test) denied(503);
      return this.applySession(
        order,
        await stripe.retrieve(order.stripe_session),
      );
    }
    if (order.expires_at.valueOf() + 120_000 < Date.now()) {
      await memberContext(this.database, actor, (client) =>
        expireOrder(client, id),
      );
      return this.memberOrder(actor, id);
    }
    return order;
  }

  async cancelCard(actor: string, id: string) {
    const order = await this.memberOrder(actor, id);
    if (order.method !== "card") denied(409);
    if (order.status !== "pending") return;
    const stripe = this.settings.stripe;
    if (!stripe || stripe.test !== order.test) denied(503);
    // Replay the provider's idempotency key if the initial create timed out.
    // Never allow a replacement until Stripe confirms the old session is closed.
    if (
      !order.stripe_session &&
      order.expires_at.valueOf() - Date.now() < 31 * 60_000
    ) {
      await this.check(actor, id);
      return;
    }
    const idAtProvider =
      order.stripe_session ?? (await stripe.create(order)).id;
    await this.applySession(order, await stripe.abandon(idAtProvider));
  }

  private applySession(order: Order, session: Stripe.Checkout.Session) {
    if (!matchesSession(order, session))
      throw new Error("checkout session mismatch");
    return settlementContext(this.database, "stripe", async (client) => {
      const { rowCount } = await client.query(
        `UPDATE app.member_checkouts SET stripe_session=$2 WHERE id=$1 AND (stripe_session IS NULL OR stripe_session=$2)`,
        [order.id, session.id],
      );
      if (!rowCount) throw new Error("checkout session conflict");
      const payment = sessionPayment(order, session);
      if (payment)
        await saveSettlement(client, order, payment.status, payment.id);
      if (session.status === "expired") await expireOrder(client, order.id);
      return (await findOrder(client, order.id))!;
    });
  }

  async stripeEvent(body: unknown, header: unknown) {
    const stripe = this.settings.stripe;
    if (!stripe) denied(404);
    const action = await stripe.eventAction(stripe.event(body, header));
    if (!action) return;
    const order = await settlementContext(this.database, "stripe", (client) =>
      findOrder(client, action.orderId),
    );
    if (!order || order.test !== stripe.test) return;
    if (action.kind === "session") {
      await this.applySession(order, await stripe.retrieve(action.sessionId));
    } else if (action.amount === Number(order.amount_units)) {
      await settlementContext(this.database, "stripe", (client) =>
        saveSettlement(client, order, "reversed", action.intentId),
      );
    }
  }

  private async reconcileSolana(order: Order, signature?: string) {
    const solana = this.settings.solana;
    if (!solana || solana.test !== order.test) denied(503);
    const matched = await solana.findPayment(order, signature);
    await settlementContext(this.database, "solana", async (client) => {
      if (matched) await saveSettlement(client, order, "paid", matched);
      else if (!signature && order.expires_at.valueOf() + 120_000 < Date.now())
        await expireOrder(client, order.id);
    });
  }

  startReconciliation() {
    if (!this.settings.solana) return () => Promise.resolve();
    let active: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (active) return;
      active = this.reconcileBatch()
        .catch(() => failure("members.payment_reconcile_failed"))
        .finally(() => {
          active = undefined;
        });
    }, 4000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await active;
    };
  }

  private async reconcileBatch() {
    const orders = await settlementContext(
      this.database,
      "solana",
      async (client) => {
        const result = await client.query<Order>(
          `WITH batch AS (
           SELECT id FROM app.member_checkouts WHERE method <> 'card' AND status='pending' AND test=$1 AND next_check_at<=now()
           ORDER BY next_check_at LIMIT 4 FOR UPDATE SKIP LOCKED
         ) UPDATE app.member_checkouts AS o SET next_check_at=now()+interval '30 seconds' FROM batch WHERE o.id=batch.id RETURNING o.*`,
          [this.settings.test],
        );
        return result.rows;
      },
    );
    const results = await Promise.allSettled(
      orders.map((order) => this.reconcileSolana(order)),
    );
    if (results.some((entry) => entry.status === "rejected"))
      failure("members.payment_reconcile_failed");
  }
}
