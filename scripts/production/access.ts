import { join } from "node:path";
import { z } from "zod";
import type { CfRequest } from "./discovery.ts";
import { digest, exists, json, privateText, publish } from "./workstation.ts";

const service = z.object({
  id: z.uuid(),
  name: z.string(),
  client_id: z
    .string()
    .max(512)
    .regex(/^[a-zA-Z0-9_-]+\.access(?:\.[a-zA-Z0-9-]+)*$/),
  expires_at: z.iso.datetime({ offset: true }),
  enabled: z.boolean().optional(),
});
const issued = service.extend({
  client_secret: z.string().regex(/^[!-~]{32,512}$/),
});

export function accessPolicies(
  role: "admin" | "ssh",
  emails: string[],
  tokenId?: string,
) {
  const workforce = {
    name:
      role === "admin" ? "fv-named-administrators" : "fv-named-ssh-operators",
    decision: "allow",
    include: emails.map((email) => ({ email: { email } })),
    require: [{ auth_method: { auth_method: "mfa" } }],
    precedence: 1,
  };
  const machine =
    role === "ssh" && tokenId
      ? {
          name: "fv-deployment-machine",
          decision: "non_identity",
          include: [{ service_token: { token_id: z.uuid().parse(tokenId) } }],
          require: [],
          precedence: emails.length ? 2 : 1,
        }
      : undefined;
  const policies = [
    ...(emails.length ? [workforce] : []),
    ...(machine ? [machine] : []),
  ];
  if (!policies.length) throw new Error("empty Access policy set");
  return { workforce, machine, policies };
}

function machineEnv(service: z.infer<typeof issued>) {
  return {
    TUNNEL_SERVICE_TOKEN_ID: service.client_id,
    TUNNEL_SERVICE_TOKEN_SECRET: service.client_secret,
  };
}

// The name binds recovery of an interrupted creation to this account, VM and
// operator identity. The token grants access only when attached to the SSH app.
async function machineRecord(
  home: string,
  account: string,
  serverId: number,
  operatorPublic: string,
) {
  const key = digest(json([account, serverId, operatorPublic])).slice(0, 24);
  const name = "fv-production-ssh-" + key;
  const file = join(home, "access-" + key + ".json");
  const stored = (await exists(file))
    ? issued.parse(JSON.parse(await privateText(file)))
    : undefined;
  if (stored && (stored.name !== name || stored.enabled === false))
    throw new Error("Stored service identity drift");
  return { key, name, file, stored };
}

export async function savedMachineAccess(
  home: string,
  account: string,
  serverId: number,
  operatorPublic: string,
) {
  const { stored } = await machineRecord(
    home,
    account,
    serverId,
    operatorPublic,
  );
  if (!stored) throw new Error("No enrolled SSH service token");
  return { env: machineEnv(stored), expiresAt: Date.parse(stored.expires_at) };
}

export async function machineAccess(
  home: string,
  account: string,
  serverId: number,
  operatorPublic: string,
  api: CfRequest,
) {
  const { key, name, file, stored } = await machineRecord(
    home,
    account,
    serverId,
    operatorPublic,
  );
  const url = "accounts/" + account + "/access/service_tokens";
  const matches = z
    .array(service)
    .max(1)
    .parse(await api(url + "?name=" + name + "&per_page=2"));
  let remote = matches[0];
  const intent = join(home, "access-" + key + ".intent");
  if (remote && !stored && !(await exists(intent)))
    throw new Error("Conflicting existing service token");
  if (
    (stored &&
      (remote?.id !== stored.id || remote.client_id !== stored.client_id)) ||
    (remote && (remote.name !== name || remote.enabled === false))
  )
    throw new Error("Service identity drift");
  if (remote && Date.parse(remote.expires_at) < Date.now() + 7 * 86400_000) {
    const refreshed = service.parse(
      await api(url + "/" + remote.id + "/refresh", "POST"),
    );
    if (
      refreshed.id !== remote.id ||
      refreshed.client_id !== remote.client_id ||
      refreshed.enabled === false ||
      refreshed.name !== name ||
      Date.parse(refreshed.expires_at) < Date.now() + 7 * 86400_000
    )
      throw new Error("Invalid token renewal");
    remote = refreshed;
  }
  if (stored && remote) {
    if (stored.expires_at !== remote.expires_at)
      await publish(
        file,
        json({ ...stored, expires_at: remote.expires_at }),
        true,
      );
    return { id: stored.id, env: machineEnv(stored) };
  }
  // A one-time secret can be lost between POST and the durable local write.
  // Recover only the exact identity for a previously persisted creation intent.
  await publish(intent, json({ account, name }));
  const result = issued.parse(
    remote
      ? await api(url + "/" + remote.id + "/rotate", "POST", {
          previous_client_secret_expires_at: new Date(
            Date.now() + 3600_000,
          ).toISOString(),
        })
      : await api(url, "POST", { name, duration: "720h" }),
  );
  if (
    result.name !== name ||
    result.enabled === false ||
    (remote &&
      (result.id !== remote.id || result.client_id !== remote.client_id))
  )
    throw new Error("Unexpected service token response");
  await publish(file, json(result));
  return { id: result.id, env: machineEnv(result) };
}
