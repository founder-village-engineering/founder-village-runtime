import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { bearer, denied } from "../../../packages/auth/index.ts";
import {
  applicationId,
  communityId,
  memberResponseSchema,
  profileInputSchema,
  directoryQuerySchema,
  directoryResponseSchema,
  contactResponseSchema,
  checkoutInputSchema,
  checkInputSchema,
  checkoutResponseSchema,
  checkoutSchema,
  deletionResponseSchema,
  membershipSchema,
  type DirectoryMember,
} from "../../../packages/frontend-contracts/founder-village-members/index.ts";
import type { MemberPayments } from "./payments.ts";
import {
  checkout,
  memberContext,
  ownProfile,
  requireProfile,
  saveProfile,
} from "./store.ts";

const idParam = z.object({ id: z.uuid() });

async function memberActor(req: FastifyRequest) {
  const identity = await bearer(req);
  if (
    req.headers["x-application-id"] !== applicationId ||
    req.headers["x-tenant-id"] !== communityId
  )
    denied(403);
  return identity.actor;
}

export function registerMemberRoutes(
  app: FastifyInstance,
  db: pg.Pool,
  payments: MemberPayments,
) {
  app.get("/members/me", async (req) => {
    const actor = await memberActor(req);
    return memberContext(db, actor, async (client) =>
      memberResponseSchema.parse({ profile: await ownProfile(client) }),
    );
  });

  app.post("/members/me", async (req) => {
    const actor = await memberActor(req);
    const input = profileInputSchema.parse(req.body);
    return memberContext(db, actor, async (client) =>
      memberResponseSchema.parse({
        profile: await saveProfile(client, actor, input, true),
      }),
    );
  });

  app.post("/members/profile", async (req) => {
    const actor = await memberActor(req);
    const input = profileInputSchema.parse(req.body);
    return memberContext(db, actor, async (client) =>
      memberResponseSchema.parse({
        profile: await saveProfile(client, actor, input, false),
      }),
    );
  });

  app.post("/members/delete", async (req) => {
    const actor = await memberActor(req);
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    return memberContext(db, actor, async (client) => {
      await client.query("DELETE FROM app.member_profiles");
      return deletionResponseSchema.parse({ deleted: true });
    });
  });

  app.get("/members/directory", async (req) => {
    const actor = await memberActor(req);
    const { q, after } = directoryQuerySchema.parse(req.query);
    return memberContext(db, actor, async (client) => {
      await requireProfile(client);
      const { rows } = await client.query<DirectoryMember>(
        `SELECT id,display_name AS name,headline,location,whatsapp_available AS "whatsappAvailable"
         FROM app.directory_members($1,$2)`,
        [q, after ?? null],
      );
      return directoryResponseSchema.parse({
        members: rows.slice(0, 24),
        next: rows.length === 25 ? rows[23]!.id : null,
      });
    });
  });

  app.get("/members/directory/:id/whatsapp", async (req) => {
    const actor = await memberActor(req);
    const { id } = idParam.parse(req.params);
    return memberContext(db, actor, async (client) => {
      const { rows } = await client.query<{ number: string | null }>(
        "SELECT app.directory_whatsapp($1) AS number",
        [id],
      );
      const number = rows[0]?.number;
      if (!number) denied(404);
      return contactResponseSchema.parse({ number });
    });
  });

  app.get("/members/membership", async (req) =>
    membershipSchema.parse(await payments.membership(await memberActor(req))),
  );

  app.post("/members/checkout", async (req) => {
    const actor = await memberActor(req);
    const { method } = checkoutInputSchema.parse(req.body);
    const key = z.uuid().parse(req.headers["idempotency-key"]);
    return checkoutResponseSchema.parse(
      await payments.start(actor, method, key),
    );
  });

  app.post("/members/checkout/:id/open", async (req) => {
    const actor = await memberActor(req);
    const { id } = idParam.parse(req.params);
    return checkoutResponseSchema.parse(await payments.open(actor, id));
  });

  app.post("/members/checkout/:id/check", async (req) => {
    const actor = await memberActor(req);
    const { id } = idParam.parse(req.params);
    const { signature } = checkInputSchema.parse(req.body);
    return checkoutSchema.parse(
      checkout(await payments.check(actor, id, signature)),
    );
  });

  app.post("/members/checkout/:id/cancel", async (req) => {
    const actor = await memberActor(req);
    const { id } = idParam.parse(req.params);
    await payments.cancelCard(actor, id);
    return membershipSchema.parse(await payments.membership(actor));
  });
}

export function registerMemberWebhook(
  app: FastifyInstance,
  payments: MemberPayments,
) {
  app.register(async (webhooks) => {
    // Stripe signatures cover the exact received bytes. Keep the parser local to this callback.
    webhooks.removeContentTypeParser("application/json");
    webhooks.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );
    webhooks.post(
      "/members/webhooks/stripe",
      { bodyLimit: 128 * 1024 },
      async (req, reply) => {
        await payments.stripeEvent(req.body, req.headers["stripe-signature"]);
        return reply.code(204).send();
      },
    );
  });
}
