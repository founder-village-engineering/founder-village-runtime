import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type pg from "pg";
import { api } from "../services/api/app.ts";
import {
  frontends,
  originAllowed,
  registeredOrigin,
} from "../packages/frontends/index.ts";
import {
  foodDeliveriesFrontendId,
  foodDeliveryInputSchema,
  foundersApplicationId,
} from "../packages/frontend-contracts/founder-food-deliveries/index.ts";
import { assertNoSymlinkPath } from "../scripts/sync-frontend-contracts.ts";

test("contract synchronization refuses symlinked target ancestors", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "fv-contracts-"));
  t.after(() => rm(root, { recursive: true }));
  const outside = resolve(root, "outside");
  await mkdir(outside);
  await mkdir(resolve(root, "apps"));
  await symlink(outside, resolve(root, "apps/example"));
  await assert.rejects(
    () =>
      assertNoSymlinkPath(root, resolve(root, "apps/example/src/generated")),
    /symlink refused/,
  );
});

test("frontend registry binds each app to its exact Pages and local origins", () => {
  const delivery = frontends.find(
    (entry) => entry.id === foodDeliveriesFrontendId,
  );
  assert(delivery);
  assert.equal(delivery.application, foundersApplicationId);
  assert.equal(
    delivery.productionOrigin,
    "https://founder-food-deliveries.pages.dev",
  );
  assert(originAllowed(foundersApplicationId, delivery.productionOrigin));
  assert(registeredOrigin("https://food-deliveries.fv"));
  for (const lookalike of [
    "https://evil.founder-food-deliveries.pages.dev",
    "https://founder-food-deliveries.pages.dev.evil.test",
    "http://founder-food-deliveries.pages.dev",
    "null",
  ]) {
    assert(!originAllowed(foundersApplicationId, lookalike));
    assert(!registeredOrigin(lookalike));
  }
});

test("food delivery inputs reject unknown fields and malformed expenses", () => {
  const valid = {
    provider: "ifood",
    providerOrderId: "IFOOD-123",
    restaurantName: "Sao Bento Kitchen",
    deliveryAddress: "Founder Village reception",
    subtotalCents: 5400,
    deliveryFeeCents: 700,
    serviceFeeCents: 300,
  };
  assert(foodDeliveryInputSchema.safeParse(valid).success);
  for (const invalid of [
    { ...valid, provider: "other" },
    { ...valid, subtotalCents: -1 },
    { ...valid, admin: true },
  ])
    assert.equal(foodDeliveryInputSchema.safeParse(invalid).success, false);
});

test("API preflights only registered origins and preserves denial headers", async (t) => {
  const previous = process.env.FV_ENV;
  process.env.FV_ENV = "local";
  t.after(() => {
    if (previous === undefined) delete process.env.FV_ENV;
    else process.env.FV_ENV = previous;
  });
  const database = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const app = await api({ [foundersApplicationId]: database });
  t.after(() => app.close());
  const origin = "https://founder-food-deliveries.pages.dev";
  const allowed = await app.inject({
    method: "OPTIONS",
    url: "/food-deliveries",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers":
        "authorization, content-type, idempotency-key, x-application-id, x-tenant-id",
    },
  });
  assert.equal(allowed.statusCode, 204, allowed.body);
  assert.equal(allowed.headers["access-control-allow-origin"], origin);
  assert(!allowed.headers["access-control-allow-credentials"]);
  const unknown = await app.inject({
    method: "OPTIONS",
    url: "/food-deliveries",
    headers: {
      origin: "https://evil.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization",
    },
  });
  assert.equal(unknown.statusCode, 403);
  assert(!unknown.headers["access-control-allow-origin"]);
  const anonymous = await app.inject({
    method: "GET",
    url: "/food-deliveries",
    headers: {
      origin,
      "x-application-id": foundersApplicationId,
      "x-tenant-id": "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.headers["access-control-allow-origin"], origin);
  const crossed = await app.inject({
    method: "GET",
    url: "/records",
    headers: {
      origin,
      "x-application-id": "founder-village",
      "x-tenant-id": "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.equal(crossed.statusCode, 403);
  assert(!crossed.headers["access-control-allow-origin"]);
});
