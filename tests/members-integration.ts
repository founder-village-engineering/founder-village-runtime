import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/addresses";
import bs58 from "bs58";
import type pg from "pg";
import { local, localToken } from "../packages/auth/index.ts";
import {
  applicationId,
  communityId,
} from "../packages/frontend-contracts/founder-village-members/index.ts";
import { api } from "../services/api/app.ts";

const settings = {
  MEMBERS_PRICE_USD_CENTS: "2500",
  MEMBERS_STRIPE_KEY: "sk_test_synthetic_fixture_only",
  MEMBERS_STRIPE_WEBHOOK_SECRET: "whsec_synthetic_fixture_only",
  MEMBERS_SOLANA_RECIPIENT: bs58.encode(randomBytes(32)),
  MEMBERS_SOLANA_RPC_URL: "https://solana.example.test/",
  MEMBERS_SOL_LAMPORTS: "90000000",
};
const system = "11111111111111111111111111111111";
const tokenProgram = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ataProgram = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const mint = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const signature = () => bs58.encode(randomBytes(64));

export async function exerciseMembers(database: pg.Pool) {
  if (!local()) throw new Error("members integration is local-only");
  const stripeSession = `cs_test_members_fixture_${randomUUID()}`;
  const portalOrigin = "http://127.0.0.1:43913";
  const stripeIntent = `pi_members_fixture_${randomUUID()}`;
  const previous = Object.fromEntries(
    Object.keys(settings).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, settings);
  const fetchOriginal = globalThis.fetch;
  let orderId = "",
    expiresAt = 0,
    stripeState = "open",
    refunded = false,
    providerCreates = 0;
  const transactions = new Map<string, unknown>();
  const recipient = settings.MEMBERS_SOLANA_RECIPIENT;
  const charge = () => ({
    id: "ch_members_fixture",
    paid: true,
    captured: true,
    livemode: false,
    refunded,
    disputed: false,
    amount_captured: 2500,
    currency: "usd",
    payment_intent: stripeIntent,
    metadata: { app: applicationId, member_order_id: orderId },
  });
  const session = () => ({
    id: stripeSession,
    livemode: false,
    mode: "payment",
    client_reference_id: orderId,
    expires_at: expiresAt,
    metadata: { app: applicationId, member_order_id: orderId },
    amount_total: 2500,
    currency: "usd",
    status: stripeState,
    payment_status: stripeState === "complete" ? "paid" : "unpaid",
    url: "https://checkout.stripe.com/c/pay/synthetic_fixture_only",
    payment_intent:
      stripeState === "complete"
        ? {
            id: stripeIntent,
            status: "succeeded",
            currency: "usd",
            amount_received: 2500,
            livemode: false,
            metadata: { app: applicationId, member_order_id: orderId },
            latest_charge: charge(),
          }
        : null,
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.stripe.com") {
      if (url.pathname === "/v1/checkout/sessions") {
        ++providerCreates;
        const body = new URLSearchParams(String(init?.body));
        orderId = body.get("client_reference_id")!;
        expiresAt = Number(body.get("expires_at"));
        assert.equal(
          new Headers(init?.headers).get("idempotency-key"),
          orderId,
        );
        assert.equal(
          body.get("line_items[0][price_data][unit_amount]"),
          "2500",
        );
        assert.equal(body.get("allowed_payment_method_types[0]"), "card");
        if (providerCreates === 1) {
          assert.equal(
            body.get("success_url"),
            `${portalOrigin}/?checkout=return`,
          );
          assert.equal(
            body.get("cancel_url"),
            `${portalOrigin}/?checkout=cancelled`,
          );
        }
      } else
        assert.equal(url.pathname, `/v1/checkout/sessions/${stripeSession}`);
      return Response.json(session());
    }
    if (url.href === settings.MEMBERS_SOLANA_RPC_URL) {
      const { method, params } = JSON.parse(String(init?.body)) as {
        method: string;
        params: unknown[];
      };
      if (method === "getGenesisHash")
        return Response.json({
          result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        });
      if (method === "getSignaturesForAddress")
        return Response.json({ result: [] });
      assert.equal(method, "getTransaction");
      assert.equal(
        (params[1] as { commitment: string }).commitment,
        "finalized",
      );
      return Response.json({
        result: transactions.get(params[0] as string) ?? null,
      });
    }
    throw new Error("unexpected fixture provider destination");
  };
  const server = await api({ [applicationId]: database });
  const suffix = randomUUID();
  const headerSet: Record<string, string>[] = await Promise.all(
    ["one", "two", "three"].map(async (id) => ({
      authorization: `Bearer ${await localToken(`members-fixture-${id}-${suffix}`)}`,
      "x-application-id": applicationId,
      "x-tenant-id": communityId,
    })),
  );
  const [one, two, three] = headerSet as [
    (typeof headerSet)[number],
    (typeof headerSet)[number],
    (typeof headerSet)[number],
  ];
  const profile = {
    name: "Synthetic Member",
    headline: "Fixture project",
    location: null,
    listed: true,
    whatsappNumber: null,
  };
  const inject = (
    url: string,
    headers: Record<string, string> = one,
    payload?: object,
  ) =>
    server.inject({
      url: `/members/${url}`,
      headers,
      ...(payload ? { method: "POST" as const, payload } : {}),
    });
  const webhook = (type: string, object: object, signed = true) => {
    const stamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ type, livemode: false, data: { object } });
    const hmac = createHmac("sha256", settings.MEMBERS_STRIPE_WEBHOOK_SECRET)
      .update(`${stamp}.${payload}`)
      .digest("hex");
    return server.inject({
      method: "POST",
      url: "/members/webhooks/stripe",
      payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${stamp},v1=${signed ? hmac : "0".repeat(64)}`,
      },
    });
  };
  try {
    assert.equal(
      (await server.inject({ url: "/members/directory" })).statusCode,
      401,
    );
    assert.equal((await inject("directory")).statusCode, 403);
    assert.equal(
      (await inject("me", { ...one, "x-tenant-id": randomUUID() })).statusCode,
      403,
    );
    assert.equal(
      (await inject("me", one, { ...profile, tier: "paid" })).statusCode,
      400,
    );
    const created = (await inject("me", one, profile)).json().profile;
    assert.equal(created.name, profile.name);
    const contact = (
      await inject("me", two, {
        ...profile,
        name: `Synthetic Contact ${suffix}`,
        whatsappNumber: "+12025550123",
      })
    ).json().profile;
    assert.equal(
      (await inject("me", one, { ...profile, name: "Irrelevant retry" })).json()
        .profile.id,
      created.id,
    );
    assert.deepEqual((await inject("me")).json(), { profile: created });
    const visible = (await inject("directory?q=fixture")).json()
      .members as Record<string, unknown>[];
    assert(
      visible.some(
        (person) =>
          person.id === contact.id && person.whatsappAvailable === true,
      ),
    );
    assert(
      visible.every(
        (person) =>
          person.id !== created.id &&
          !("whatsappNumber" in person) &&
          !("actor" in person),
      ),
    );
    assert.deepEqual(
      (await inject(`directory/${contact.id}/whatsapp`)).json(),
      { number: "+12025550123" },
    );
    assert.equal(
      (await inject(`directory/${contact.id}/whatsapp`, three)).statusCode,
      404,
    );
    assert.equal(
      (
        await inject("profile", two, {
          ...profile,
          name: contact.name,
          listed: false,
          whatsappNumber: contact.whatsappNumber,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await inject(`directory/${contact.id}/whatsapp`)).statusCode,
      404,
    );
    assert.equal(
      (await server.inject({ url: "/records", headers: one })).statusCode,
      403,
    );

    const requests = [randomUUID(), randomUUID()];
    const results = await Promise.all(
      requests.map((key) =>
        inject(
          "checkout",
          { ...one, origin: portalOrigin, "idempotency-key": key },
          { method: "card" },
        ),
      ),
    );
    assert.deepEqual(
      results.map((response) => response.statusCode).sort(),
      [200, 409],
    );
    const first = results
      .find((response) => response.statusCode === 200)!
      .json();
    assert.equal(first.action.kind, "stripe");
    assert.equal(first.checkout.status, "pending");
    const firstKey =
      requests[results.findIndex((response) => response.statusCode === 200)]!;
    {
      assert.equal(
        (
          await inject(
            "checkout",
            { ...one, "idempotency-key": firstKey },
            { method: "sol" },
          )
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await inject(
            "checkout",
            { ...one, "idempotency-key": firstKey },
            { method: "card" },
          )
        ).json().checkout.id,
        first.checkout.id,
      );
    }
    assert.equal(providerCreates, 1);
    assert.equal(
      (await inject(`checkout/${first.checkout.id}/check`, two, {})).statusCode,
      404,
    );
    assert.equal((await inject("membership")).json().tier, "free");
    stripeState = "complete";
    assert.equal(
      (await webhook("checkout.session.completed", session(), false))
        .statusCode,
      400,
    );
    assert.equal((await inject("membership")).json().tier, "free");
    for (let retry = 0; retry < 2; retry++)
      assert.equal(
        (await webhook("checkout.session.completed", session())).statusCode,
        204,
      );
    assert.equal((await inject("membership")).json().tier, "paid");
    refunded = true;
    assert.equal((await webhook("charge.refunded", charge())).statusCode, 204);
    assert.equal(
      (await webhook("checkout.session.completed", session())).statusCode,
      204,
    );
    assert.equal((await inject("membership")).json().tier, "free");

    async function crypto(
      method: "sol" | "usdc",
      headers: typeof one,
      key: string,
    ) {
      const result = await inject(
        "checkout",
        { ...headers, "idempotency-key": key },
        { method },
      );
      assert.equal(result.statusCode, 200, result.body);
      const data = result.json();
      assert.equal(data.action.network, "devnet");
      const url = new URL(data.action.url);
      assert.equal(url.pathname, recipient);
      return {
        id: data.checkout.id as string,
        url,
        reference: url.searchParams.get("reference")!,
      };
    }
    const sol = await crypto("sol", one, randomUUID());
    assert.equal(sol.url.searchParams.get("amount"), "0.09");
    const solPayment = signature();
    const transfer = Buffer.alloc(12);
    transfer.writeUInt32LE(2);
    transfer.writeBigUInt64LE(90000000n, 4);
    const tx = (
      id: string,
      accountKeys: string[],
      data: Buffer,
      accounts: number[],
      meta: Record<string, unknown>,
    ) => ({
      transaction: {
        signatures: [id],
        message: {
          accountKeys,
          instructions: [
            { programIdIndex: 0, accounts, data: bs58.encode(data) },
          ],
        },
      },
      meta: { err: null, preBalances: [], postBalances: [], ...meta },
      blockTime: Math.floor(Date.now() / 1000),
    });
    const balances = {
      preBalances: [0, 0, 0, 10000000],
      postBalances: [0, 0, 0, 100000000],
    };
    for (const fixture of [
      tx(
        solPayment,
        [system, mint, sol.reference, recipient],
        transfer,
        [1, 3, 1],
        balances,
      ),
      tx(
        solPayment,
        [system, mint, sol.reference, recipient],
        transfer,
        [1, 3, 2],
        { ...balances, postBalances: [0, 0, 0, 99999999] },
      ),
    ]) {
      transactions.set(solPayment, fixture);
      assert.equal(
        (
          await inject(`checkout/${sol.id}/check`, one, {
            signature: solPayment,
          })
        ).json().status,
        "pending",
      );
    }
    transactions.set(
      solPayment,
      tx(
        solPayment,
        [system, mint, sol.reference, recipient],
        transfer,
        [1, 3, 2],
        balances,
      ),
    );
    assert.equal(
      (
        await inject(`checkout/${sol.id}/check`, one, { signature: solPayment })
      ).json().status,
      "paid",
    );
    assert.equal(
      (
        await inject(`checkout/${sol.id}/check`, one, { signature: solPayment })
      ).json().status,
      "paid",
    );
    assert.equal((await inject("membership")).json().tier, "paid");

    const usdc = await crypto("usdc", two, randomUUID());
    assert.equal(usdc.url.searchParams.get("spl-token"), mint);
    assert.equal(usdc.url.searchParams.get("amount"), "25");
    const usdcPayment = signature();
    const encoder = getAddressEncoder();
    const [ata] = await getProgramDerivedAddress({
      programAddress: ataProgram,
      seeds: [
        encoder.encode(address(recipient)),
        encoder.encode(tokenProgram),
        encoder.encode(mint),
      ],
    });
    const transferChecked = Buffer.alloc(10);
    transferChecked[0] = 12;
    transferChecked.writeBigUInt64LE(25000000n, 1);
    transferChecked[9] = 6;
    const tokenBalance = {
      accountIndex: 3,
      mint,
      owner: recipient,
      programId: tokenProgram,
      uiTokenAmount: { amount: "25000000", decimals: 6 },
    };
    transactions.set(
      usdcPayment,
      tx(
        usdcPayment,
        [tokenProgram, system, mint, ata, recipient, usdc.reference],
        transferChecked,
        [1, 2, 3, 4, 5],
        { postTokenBalances: [{ ...tokenBalance, mint: system }] },
      ),
    );
    assert.equal(
      (
        await inject(`checkout/${usdc.id}/check`, two, {
          signature: usdcPayment,
        })
      ).json().status,
      "pending",
    );
    transactions.set(
      usdcPayment,
      tx(
        usdcPayment,
        [tokenProgram, system, mint, ata, recipient, usdc.reference],
        transferChecked,
        [1, 2, 3, 4, 5],
        { postTokenBalances: [tokenBalance] },
      ),
    );
    assert.equal(
      (
        await inject(`checkout/${usdc.id}/check`, two, {
          signature: usdcPayment,
        })
      ).json().status,
      "paid",
    );
    assert.equal((await inject("membership", two)).json().tier, "paid");
    assert.equal(
      (await inject("delete", two, { confirm: true })).statusCode,
      200,
    );
    assert.equal((await inject("me", two)).json().profile, null);
    const recreated = await inject("me", two, profile);
    assert.notEqual(recreated.json().profile.id, contact.id);
    assert.equal((await inject("membership", two)).json().tier, "free");
  } finally {
    for (const headers of headerSet)
      await inject("delete", headers, { confirm: true });
    await server.close();
    globalThis.fetch = fetchOriginal;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
