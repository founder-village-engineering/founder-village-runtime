import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  machineAccess,
  savedMachineAccess,
} from "../scripts/production/access.ts";
import type { CfRequest } from "../scripts/production/discovery.ts";

test("scheduled backups reuse the enrolled service secret and provider-confirmed renewal expiry", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "fv-backup-renew-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const binding = [home, "a".repeat(32), 50, "fixture-operator"] as const;
  const secret = randomBytes(32).toString("hex");
  const service = {
    id: randomUUID(),
    name: "",
    client_id: "fixture.access",
    enabled: true,
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
  };
  let renewals = 0;
  const api: CfRequest = async (path, method, body) => {
    if (!method) return service.name ? [service] : [];
    assert.equal(method, "POST");
    if (!service.name) {
      assert.ok(path.endsWith("/service_tokens"));
      service.name = (body as { name: string }).name;
      return { ...service, client_secret: secret };
    }
    assert.ok(path.endsWith("/" + service.id + "/refresh"));
    renewals++;
    service.expires_at = new Date(Date.now() + 30 * 86400_000).toISOString();
    return service;
  };
  const original = await machineAccess(...binding, api);
  const old = await savedMachineAccess(...binding);
  assert.deepEqual(await machineAccess(...binding, api), original);
  const fresh = await savedMachineAccess(...binding);
  assert.equal(fresh.env.TUNNEL_SERVICE_TOKEN_SECRET, secret);
  assert.ok(fresh.expiresAt > old.expiresAt);
  assert.equal(fresh.expiresAt, Date.parse(service.expires_at));
  await machineAccess(...binding, api);
  assert.equal(renewals, 1);
  await assert.rejects(savedMachineAccess(home, binding[1], 51, binding[3]));
});
