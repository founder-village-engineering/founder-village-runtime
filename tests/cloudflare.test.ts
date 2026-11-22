import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Cloudflare,
  fingerprint,
  type Existing,
} from "../packages/operations/cloudflare.ts";
process.env.CF_MANAGED_NAMES = "canary.example.com";
process.env.CF_ZONE_NAME = "example.com";
process.env.CF_ZONE_ID = "00000000000000000000000000000000";
class Fixture extends Cloudflare {
  state: Existing | null = {
    id: "synthetic",
    name: "canary.example.com",
    type: "A",
    content: "192.0.2.1",
    proxied: false,
    ttl: 300,
  };
  skipDelete = false;
  calls: string[][] = [];
  override async call(args: string[]): Promise<unknown> {
    this.calls.push(args);
    if (args[2] === "list") return this.state ? [this.state] : [];
    if (args[2] === "delete") {
      if (!this.skipDelete) this.state = null;
      return { success: true };
    }
    if (args[2] === "update" || args[2] === "create") {
      this.state = { id: "synthetic", ...JSON.parse(args.at(-1)!) } as Existing;
      return this.state;
    }
    throw new Error("unexpected fixture command");
  }
}
test("DNS fingerprint survives JSONB key ordering and rejects drift", async () => {
  const cf = new Fixture(true);
  const before = cf.state!;
  const reordered = Object.fromEntries(
    Object.entries(before).reverse(),
  ) as Existing;
  assert.equal(fingerprint(before), fingerprint(reordered));
  await cf.apply(before.name, reordered, {
    name: before.name,
    type: "A",
    content: "192.0.2.2",
    ttl: 300,
    proxied: false,
  });
  assert.equal(cf.state?.content, "192.0.2.2");
  await assert.rejects(() => cf.apply(before.name, before, null), /drift/);
});
test("a successful CLI exit without deletion fails its postcondition", async () => {
  const cf = new Fixture(true);
  cf.skipDelete = true;
  await assert.rejects(
    () => cf.apply("canary.example.com", cf.state, null),
    /postcondition/,
  );
  assert(cf.calls.some((a) => a.includes("--force")));
});
test("unmanaged domains never reach the CLI", async () => {
  const cf = new Fixture(true);
  await assert.rejects(() => cf.inventory("unrelated.example.com"));
  assert.equal(cf.calls.length, 0);
});
test("only the tunnel provisioner can publish a proxied tunnel CNAME for a reserved hostname", async (t) => {
  const previous = process.env.CF_TUNNEL_NAMES;
  t.after(() => {
    if (previous === undefined) delete process.env.CF_TUNNEL_NAMES;
    else process.env.CF_TUNNEL_NAMES = previous;
  });
  const host = "canary.example.com";
  process.env.CF_TUNNEL_NAMES = host;
  const cf = new Fixture(true);
  const tunnelId = "11111111-2222-4333-8444-555555555555";
  await assert.rejects(() => cf.apply(host, cf.state, null), /tunnel workflow/);
  await assert.rejects(
    () => cf.ensureTunnelRecord(host, tunnelId, cf.state, false),
    /review/,
  );
  assert.equal(cf.calls.length, 0);
  cf.state = null;
  await assert.rejects(
    () => cf.ensureTunnelRecord(host, tunnelId, null, true),
    /review/,
  );
  await cf.ensureTunnelRecord(host, tunnelId, null, false);
  const record = cf.state as Existing | null;
  assert.equal(record?.content, `${tunnelId}.cfargotunnel.com`);
  assert.equal(record?.type, "CNAME");
  assert.equal(record?.proxied, true);
  await cf.ensureTunnelRecord(host, tunnelId, record, true);
});
test("nested records remain forbidden even if explicitly allowlisted", async (t) => {
  const previous = process.env.CF_MANAGED_NAMES;
  t.after(() => {
    process.env.CF_MANAGED_NAMES = previous;
  });
  process.env.CF_MANAGED_NAMES =
    "api.dev.example.com,example.com,*.example.com,api-dev.example.com";
  const cf = new Fixture(true);
  for (const host of ["api.dev.example.com", "example.com", "*.example.com"])
    await assert.rejects(() => cf.inventory(host));
  assert.equal(cf.calls.length, 0);
  cf.allowed("api-dev.example.com");
});
