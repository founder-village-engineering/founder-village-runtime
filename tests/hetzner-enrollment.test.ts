import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserToken } from "../scripts/production/browser-token.ts";
import { enrollHetzner } from "../scripts/production/enroll-hetzner.ts";
import { publish } from "../scripts/production/workstation.ts";

test("the one-use browser form accepts only its own origin and submission nonce", async () => {
  let received!: Promise<string>;
  const url = new URL(
    await new Promise<string>((ready) => {
      received = browserToken("cloudflare", ready);
    }),
  );
  assert.equal(url.hostname, "127.0.0.1");
  const page = await fetch(url);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  assert.match(html, /Temporary Cloudflare issuer token/);
  const nonce = /<script nonce="([A-Za-z0-9_-]+)">/.exec(html)![1]!;
  const fixture = randomUUID();
  const post = (origin: string, csrf: string) =>
    fetch(new URL("/enroll", url), {
      method: "POST",
      headers: { origin, "x-fv-csrf": csrf, "content-type": "text/plain" },
      body: fixture,
    });
  assert.equal((await post("https://untrusted.example", nonce)).status, 403);
  assert.equal((await post(url.origin, "wrong")).status, 403);
  assert.equal((await post(url.origin, nonce)).status, 204);
  assert.equal(await received, fixture);
});

test("Hetzner enrollment writes the new token only after a matching candidate audit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fv-enroll-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env;
  process.env = { CREDENTIALS_DIRECTORY: directory };
  t.after(() => {
    process.env = previous;
  });
  const pin = join(directory, "candidate.private.json");
  const candidate = {
    environment: "production",
    project: "fixture",
    provider: { existing_server: { id: 1, ipv4: "192.0.2.1" } },
  };
  const token = randomUUID();
  const values = new Map<string, string>();
  const vault = {
    async read() {
      return { record: undefined, values };
    },
    async merge(incoming: ReadonlyMap<string, string>) {
      for (const [key, value] of incoming) values.set(key, value);
      return { added: incoming.size, values };
    },
  };
  const audit = async (input: string, bearer: string) => {
    assert.deepEqual(JSON.parse(input), candidate);
    assert.equal(bearer, token);
    assert.equal(values.has("FV_HCLOUD_TOKEN"), false);
  };
  await assert.rejects(
    enrollHetzner(token, vault, pin, audit),
    /pinned production/,
  );
  await publish(pin, JSON.stringify(candidate));
  await assert.rejects(
    enrollHetzner(token, vault, pin, async () => {
      throw new Error(token);
    }),
    /did not pass/,
  );
  assert.equal(values.has("FV_HCLOUD_TOKEN"), false);
  values.set(
    "FV_HETZNER_CANDIDATE",
    JSON.stringify({ ...candidate, environment: "staging" }),
  );
  await assert.rejects(enrollHetzner(token, vault, pin, audit), /disagree/);
  values.set("FV_HETZNER_CANDIDATE", JSON.stringify(candidate));
  await enrollHetzner(token, vault, pin, audit);
  assert.equal(values.get("FV_HCLOUD_TOKEN"), token);
  await assert.rejects(
    enrollHetzner(randomUUID(), vault, pin, audit),
    /conflicts/,
  );
});
