import Stripe from "stripe";
import { z } from "zod";
import { denied } from "../../../packages/auth/index.ts";
import {
  applicationId,
  checkoutActionSchema,
} from "../../../packages/frontend-contracts/founder-village-members/index.ts";
import type { Order } from "./store.ts";

const attemptId = z.uuid();
const stripeMetadata = (order: Order) => ({
  app: applicationId,
  member_order_id: order.id,
});

export function matchesSession(order: Order, session: Stripe.Checkout.Session) {
  return (
    session.livemode !== order.test &&
    session.mode === "payment" &&
    session.metadata?.app === applicationId &&
    session.metadata.member_order_id === order.id &&
    session.client_reference_id === order.id &&
    session.currency === "usd" &&
    session.amount_total === Number(order.amount_units) &&
    session.expires_at === Math.floor(order.expires_at.valueOf() / 1000) &&
    (!order.stripe_session || order.stripe_session === session.id)
  );
}

export function sessionPayment(order: Order, session: Stripe.Checkout.Session) {
  if (
    !matchesSession(order, session) ||
    session.payment_status !== "paid" ||
    session.status !== "complete"
  )
    return;
  const intent = session.payment_intent;
  if (
    !intent ||
    typeof intent === "string" ||
    intent.status !== "succeeded" ||
    intent.currency !== "usd" ||
    intent.livemode === order.test ||
    intent.amount_received !== Number(order.amount_units) ||
    intent.metadata.app !== applicationId ||
    intent.metadata.member_order_id !== order.id
  )
    return;
  const charge = intent.latest_charge;
  if (
    !charge ||
    typeof charge === "string" ||
    !charge.paid ||
    !charge.captured ||
    charge.amount_captured !== Number(order.amount_units)
  )
    return;
  return {
    id: intent.id,
    status:
      charge.refunded || charge.disputed
        ? ("reversed" as const)
        : ("paid" as const),
  };
}

export class StripePayments {
  readonly client: Stripe;

  constructor(
    key: string,
    private readonly webhookKey: string,
    readonly test: boolean,
    private readonly origin: string,
  ) {
    this.client = new Stripe(key, {
      timeout: 5000,
      maxNetworkRetries: 0,
      telemetry: false,
      httpClient: Stripe.createFetchHttpClient((input, init) =>
        fetch(input, { ...init, redirect: "error" }),
      ),
    });
  }

  create(order: Order) {
    const metadata = stripeMetadata(order);
    return this.client.checkout.sessions.create(
      {
        mode: "payment",
        ui_mode: "hosted_page",
        adaptive_pricing: { enabled: false },
        allowed_payment_method_types: ["card"],
        client_reference_id: order.id,
        metadata,
        payment_intent_data: { metadata },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: Number(order.amount_units),
              product_data: { name: "Founder Village paid membership" },
            },
          },
        ],
        expires_at: Math.floor(order.expires_at.valueOf() / 1000),
        success_url: `${this.origin}/?checkout=return`,
        cancel_url: `${this.origin}/?checkout=cancelled`,
      },
      { idempotencyKey: order.id },
    );
  }

  action(session: Stripe.Checkout.Session) {
    return checkoutActionSchema.parse({ kind: "stripe", url: session.url });
  }

  retrieve(id: string) {
    return this.client.checkout.sessions.retrieve(id, {
      expand: ["payment_intent.latest_charge"],
    });
  }

  async abandon(id: string) {
    try {
      return await this.client.checkout.sessions.expire(id);
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeInvalidRequestError))
        throw error;
      return this.retrieve(id);
    }
  }

  event(body: unknown, header: unknown) {
    if (
      !Buffer.isBuffer(body) ||
      typeof header !== "string" ||
      header.length > 4096
    )
      denied(400);
    try {
      return this.client.webhooks.constructEvent(body, header, this.webhookKey);
    } catch {
      denied(400);
    }
  }

  async eventAction(event: Stripe.Event) {
    if (event.livemode === this.test) return;
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.expired": {
        const session = event.data.object;
        const id = attemptId.safeParse(session.metadata?.member_order_id);
        if (session.metadata?.app !== applicationId || !id.success) return;
        return {
          kind: "session" as const,
          orderId: id.data,
          sessionId: session.id,
        };
      }
      case "charge.refunded":
        return this.reversal(event.data.object, false);
      case "charge.dispute.created": {
        const charge = event.data.object.charge;
        return this.reversal(
          typeof charge === "string"
            ? await this.client.charges.retrieve(charge)
            : charge,
          true,
        );
      }
    }
  }

  private reversal(charge: Stripe.Charge, disputed: boolean) {
    const id = attemptId.safeParse(charge.metadata.member_order_id);
    const intentId =
      typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent?.id;
    if (
      !id.success ||
      charge.metadata.app !== applicationId ||
      !intentId ||
      charge.livemode === this.test ||
      charge.currency !== "usd" ||
      !charge.paid ||
      !charge.captured ||
      (!disputed && !charge.refunded)
    )
      return;
    return {
      kind: "reversal" as const,
      orderId: id.data,
      intentId,
      amount: charge.amount_captured,
    };
  }
}
