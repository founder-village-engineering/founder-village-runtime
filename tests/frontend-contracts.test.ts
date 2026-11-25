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
import { applicationId } from "../packages/frontend-contracts/founder-village-app/index.ts";
import { foodDeliveryInputSchema } from "../packages/frontend-contracts/founder-village-app/food-deliveries.ts";
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
  assert.deepEqual(frontends.map((entry) => entry.id).sort(), [
    applicationId,
    "founder-village-team",
  ]);
  const primary = frontends.find((entry) => entry.id === applicationId);
  assert(primary);
  assert.equal(primary.application, applicationId);
  assert.equal(
    primary.productionOrigin,
    "https://founder-village-app.pages.dev",
  );
  assert(
    originAllowed(applicationId, primary.productionOrigin, "/food-deliveries"),
  );
  assert(registeredOrigin("https://app.fv"));
  assert(!registeredOrigin("https://food-deliveries.fv"));
  assert(!registeredOrigin("https://members.fv"));
  const teamOrigin = "https://team.foundervillage.xyz";
  assert(originAllowed("founder-village-team", teamOrigin));
  assert(!originAllowed(applicationId, teamOrigin));
  assert(!registeredOrigin("https://other.team.foundervillage.xyz"));
  assert(!registeredOrigin("https://team.foundervillage.xyz.example.test"));
  for (const lookalike of [
    "https://evil.founder-village-app.pages.dev",
    "https://founder-village-app.pages.dev.evil.test",
    "http://founder-village-app.pages.dev",
    "https://www.founderhaus.org",
    "https://foundervillage.org.evil.test",
    "https://founderhaus.org:444",
    "null",
  ]) {
    assert(!originAllowed(applicationId, lookalike));
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

test("the primary surface is confined to each feature's registered routes", () => {
  for (const origin of [
    "https://founder-village-app.pages.dev",
    "https://founderhaus.org",
    "https://foundervillage.org",
    "https://app.fv",
    "http://127.0.0.1:43913",
  ]) {
    for (const [application, path] of [
      [applicationId, "/v1/members/directory?q=garden"],
      [applicationId, "/food-deliveries/tenants"],
      ["founder-village-team", "/v1/team/engineering/items"],
      ["founder-village-team", "/v1/team/conversations/123/messages"],
    ] as const) {
      assert(registeredOrigin(origin, path));
      assert(originAllowed(application, origin, path));
      assert(!originAllowed("founder-village", origin, path));
    }
    for (const path of [
      "/v1/records",
      "/graphql",
      "/v1/team/local-login",
      "/v1/members/webhooks/stripe",
    ])
      assert(!registeredOrigin(origin, path));
    assert(!originAllowed("founder-village-team", origin, "/v1/members/me"));
  }
  assert(
    !registeredOrigin(
      "https://branch.founder-village-app.pages.dev",
      "/v1/team/tenants",
    ),
  );
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
  const app = await api({
    [applicationId]: database,
    "founder-village-team": database,
  });
  t.after(() => app.close());
  const origin = "https://founder-village-app.pages.dev";
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
      "x-application-id": applicationId,
      "x-tenant-id": "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.headers["access-control-allow-origin"], origin);
  for (const alias of [
    "https://founderhaus.org",
    "https://foundervillage.org",
  ]) {
    for (const [application, path] of [
      [applicationId, "/v1/members/me"],
      [applicationId, "/v1/food-deliveries/tenants"],
      ["founder-village-team", "/v1/team/tenants"],
    ] as const) {
      const response = await app.inject({
        method: "GET",
        url: path,
        headers: { origin: alias, "x-application-id": application },
      });
      assert.equal(response.statusCode, 401, path);
      assert.equal(response.headers["access-control-allow-origin"], alias);
    }
  }
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
