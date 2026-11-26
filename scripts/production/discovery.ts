import {
  GetBucketAclCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { get } from "node:https";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { boundedJson } from "../../packages/observability/http.ts";
import {
  frontends,
  productionOrigins,
} from "../../packages/frontends/index.ts";
import {
  hostOptional,
  hostRequired,
  operatorRequired,
  runtimePolicy,
} from "./bindings.ts";
import {
  BootstrapError,
  credential,
  digest,
  ed25519,
  exists,
  json,
  privateText,
  publish,
  run,
  stage,
} from "./workstation.ts";

const accountId = z.string().regex(/^[0-9a-f]{32}$/);
const shortName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const token = z.string().regex(/^[!-~]{1,2048}$/);
const candidateSchema = z
  .object({
    project: shortName,
    environment: z.literal("production"),
    root_disk_gb: z.number().positive().int().optional(),
    provider: z
      .object({
        name: z.literal("hetzner"),
        architecture: z.enum(["arm64", "amd64"]),
        server_type: shortName,
        location: shortName,
        image: z.string().optional(),
        existing_server: z.object({
          id: z.number().int().positive(),
          ipv4: z.ipv4(),
        }),
        ssh_key_ids: z.array(z.number().int().positive()),
        project_resource_ids: z
          .record(z.string(), z.array(z.number().int().positive()))
          .optional(),
      })
      .strict(),
  })
  .strict();
const serverSchema = z.object({
  id: z.number().int().positive(),
  name: shortName,
  labels: z.record(z.string(), z.string()),
  public_net: z.object({ ipv4: z.object({ ip: z.ipv4() }) }),
  location: z.object({ name: shortName }),
  image: z.object({ name: z.string(), type: z.literal("system") }),
  server_type: z.object({
    name: shortName,
    architecture: z.enum(["arm", "x86"]),
  }),
});
export const apexZones = productionOrigins(
  frontends.find((app) => app.id === "founder-village-app")!,
)
  .map((origin) => new URL(origin).hostname)
  .filter((name) => !name.endsWith(".pages.dev"));
export async function getJson(url: string, bearer?: string) {
  const res = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: bearer ? { authorization: "Bearer " + token.parse(bearer) } : {},
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error("Provider read failed");
  }
  return boundedJson(res);
}
export type CfRequest = (
  path: string,
  method?: "GET" | "POST",
  body?: object,
) => Promise<unknown>;
export function cloudApi(bearer: string): CfRequest {
  return async (path, method = "GET", body) => {
    const res = await fetch("https://api.cloudflare.com/client/v4/" + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        authorization: "Bearer " + token.parse(bearer),
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error("Cloudflare request failed");
    }
    const reply = z
      .object({ success: z.literal(true), result: z.unknown() })
      .parse(await boundedJson(res));
    return reply.result;
  };
}
export async function cloudBinding(
  zoneName: string,
  adminDomain: string,
  project: string,
  read: CfRequest,
  provision: CfRequest,
  expected?: string,
) {
  const zone = z.object({
    name: z.string(),
    id: accountId,
    status: z.literal("active"),
    account: z.object({ id: accountId }),
  });
  const zones = await Promise.all(
    apexZones.map(async (name) => {
      const [result] = z
        .tuple([zone])
        .parse(await read("zones?name=" + name + "&status=active&per_page=2"));
      if (result.name !== name) throw new Error("Zone name mismatch");
      return result;
    }),
  );
  const primary = zones.find((z) => z.name === zoneName);
  if (
    !primary ||
    zones.some((z) => z.account.id !== primary.account.id) ||
    (expected && primary.account.id !== expected)
  )
    throw new Error("Zone custody mismatch");
  const organization = z
    .object({ auth_domain: z.string() })
    .parse(
      await provision(
        "accounts/" + primary.account.id + "/access/organizations",
      ),
    );
  const match = /^([a-z0-9-]+)\.cloudflareaccess\.com$/.exec(
    organization.auth_domain,
  );
  const [admin] = z
    .array(
      z.object({
        name: z.literal(project + "-admin"),
        domain: z.literal(adminDomain),
        type: z.literal("self_hosted"),
        aud: z.string().min(1),
      }),
    )
    .max(1)
    .parse(
      await provision(
        "accounts/" +
          primary.account.id +
          "/access/apps?domain=" +
          encodeURIComponent(adminDomain) +
          "&exact=true&per_page=2",
      ),
    );
  return {
    account_id: primary.account.id,
    zone_id: primary.id,
    access_team: shortName.parse(match?.[1]),
    access_aud: admin?.aud ?? "",
  };
}

// Existing VM enrollment takes its public host key from machine custody, a
// previously verified binding, or two halves of the raw 32-byte Ed25519 key
// published by a trusted image provisioner in the authenticated server labels.
export function hostKeyFromLabels(labels: Record<string, string>) {
  const left = labels["fv-ssh-host-key-1"],
    right = labels["fv-ssh-host-key-2"];
  if (left === undefined && right === undefined) return undefined;
  if (!/^[0-9a-f]{32}$/.test(left ?? "") || !/^[0-9a-f]{32}$/.test(right ?? ""))
    throw new Error("Invalid host enrollment");
  const header = Buffer.from("0000000b7373682d6564323535313900000020", "hex");
  return ed25519(
    "ssh-ed25519 " +
      Buffer.concat([header, Buffer.from(left! + right!, "hex")]).toString(
        "base64",
      ),
  );
}
export async function providerBinding(
  root: string,
  work: string,
  home: string,
  normalName: string,
  bearer: string,
) {
  const file = join(root, "config/candidate.private.json");
  const provided =
    (await credential("FV_HETZNER_CANDIDATE")) ??
    ((await exists(file)) ? await privateText(file) : undefined);
  const saved = provided
    ? candidateSchema.parse(JSON.parse(provided))
    : undefined;
  const name = saved?.project ?? normalName;
  const base = "https://api.hetzner.cloud/v1/servers";
  const server = saved
    ? z
        .object({ server: serverSchema })
        .parse(
          await getJson(base + "/" + saved.provider.existing_server.id, bearer),
        ).server
    : z
        .object({ servers: z.tuple([serverSchema]) })
        .parse(
          await getJson(
            base + "?per_page=2&name=" + shortName.parse(name),
            bearer,
          ),
        ).servers[0];
  if (server.name !== name || (!saved && server.labels["fv-owner"] !== name))
    throw new Error("Verified existing server binding required");
  const candidate =
    saved ??
    candidateSchema.parse({
      project: name,
      environment: "production",
      provider: {
        name: "hetzner",
        location: server.location.name,
        server_type: server.server_type.name,
        architecture:
          server.server_type.architecture === "arm" ? "arm64" : "amd64",
        image: server.image.name,
        ssh_key_ids: [],
        existing_server: { id: server.id, ipv4: server.public_net.ipv4.ip },
      },
    });
  const binding = candidate.provider.existing_server;
  if (binding.id !== server.id || binding.ipv4 !== server.public_net.ipv4.ip)
    throw new Error("Existing server changed");
  const auditFile = join(work, "candidate.private.json");
  await publish(auditFile, json(candidate));
  const audit = z
    .object({
      project_isolated: z.literal(true),
      running: z.literal(true),
      image: z.literal(server.image.name),
    })
    .parse(
      JSON.parse(
        await run("bin/fv", ["--config", auditFile, "candidate-audit"], {
          FV_HCLOUD_TOKEN: bearer,
        }),
      ),
    );
  const pinFile = join(home, "server-binding.json");
  const prior = (await exists(pinFile))
    ? z
        .object({
          id: z.literal(binding.id),
          ipv4: z.literal(binding.ipv4),
          project: z.literal(name),
          key: z.string(),
        })
        .parse(JSON.parse(await privateText(pinFile)))
    : undefined;
  const keys = [
    await credential("FV_SSH_HOST_PUBLIC_KEY"),
    hostKeyFromLabels(server.labels),
    prior?.key,
  ]
    .filter((key): key is string => !!key)
    .map(ed25519);
  if (!keys[0] || new Set(keys).size !== 1)
    throw new BootstrapError(
      "The existing VM has no matching machine-attested SSH host key.",
    );
  await publish(pinFile, json({ ...binding, project: name, key: keys[0] }));
  return {
    project: name,
    provider: { ...candidate.provider, image: audit.image },
    key: keys[0],
  };
}

export function httpsEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[\s\\]/.test(value)
  )
    throw new Error("Expected an HTTPS endpoint");
  return value;
}
export async function oidcSettings(v: Record<string, string>) {
  const issuer = httpsEndpoint(v.OIDC_ISSUER!);
  const discovery = z
    .object({
      issuer: z.literal(issuer),
      jwks_uri: z.string(),
      authorization_endpoint: z.string(),
      token_endpoint: z.string(),
      code_challenge_methods_supported: z.array(z.string()).optional(),
    })
    .parse(
      await getJson(
        issuer.replace(/\/$/, "") + "/.well-known/openid-configuration",
      ),
    );
  if (
    discovery.code_challenge_methods_supported &&
    !discovery.code_challenge_methods_supported.includes("S256")
  )
    throw new Error("OIDC provider does not support required PKCE method");
  const ids = [v.OIDC_CLIENT_ID!, v.OIDC_AUDIENCE!, v.FV_APP_OIDC_CLIENT_ID!];
  if (new Set(ids).size !== 3 || ids.some((id) => !/^[!-~]{1,256}$/.test(id)))
    throw new Error("Invalid OIDC registrations");
  const actors = z
    .array(z.string().min(3).max(512))
    .parse(JSON.parse(v.ROOT_ADMIN_ACTORS ?? "[]"));
  if (
    actors.some(
      (actor) =>
        !actor.startsWith(issuer + "|") || actor.length === issuer.length + 1,
    )
  )
    throw new Error("Invalid administrator issuer");
  return {
    issuer,
    authorization_endpoint: httpsEndpoint(discovery.authorization_endpoint),
    token_endpoint: httpsEndpoint(discovery.token_endpoint),
    jwks_url: httpsEndpoint(discovery.jwks_uri),
    audience: ids[1]!,
    client_id: ids[0]!,
    root_actors: actors,
    frontend_client_ids: { "founder-village-app": ids[2]! },
  };
}
export async function storageBinding(v: Record<string, string>) {
  const source = httpsEndpoint(v.BACKUP_S3_ENDPOINT!),
    mirror = httpsEndpoint(v.IMMUTABLE_ENDPOINT!);
  if (
    v.BACKUP_S3_KEY === v.IMMUTABLE_ACCESS_KEY ||
    (source === mirror && v.BACKUP_S3_BUCKET === v.IMMUTABLE_BUCKET)
  )
    throw new Error("Independent immutable custody required");
  const client = (
    endpoint: string,
    region: string,
    accessKeyId: string,
    secretAccessKey: string,
  ) =>
    new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      maxAttempts: 2,
      credentials: { accessKeyId, secretAccessKey },
      requestHandler: { requestTimeout: 15_000, connectionTimeout: 5000 },
    });
  const a = client(
    source,
    v.BACKUP_S3_REGION!,
    v.BACKUP_S3_KEY!,
    v.BACKUP_S3_SECRET!,
  );
  const b = client(
    mirror,
    v.IMMUTABLE_REGION!,
    v.IMMUTABLE_ACCESS_KEY!,
    v.IMMUTABLE_SECRET_KEY!,
  );
  const Bucket = v.IMMUTABLE_BUCKET!;
  try {
    const [one, two, version, lock] = await Promise.all([
      a.send(new GetBucketAclCommand({ Bucket: v.BACKUP_S3_BUCKET! })),
      b.send(new GetBucketAclCommand({ Bucket })),
      b.send(new GetBucketVersioningCommand({ Bucket })),
      b.send(new GetObjectLockConfigurationCommand({ Bucket })),
    ]);
    if (
      !one.Owner?.ID ||
      !two.Owner?.ID ||
      one.Owner.ID === two.Owner.ID ||
      version.Status !== "Enabled" ||
      lock.ObjectLockConfiguration?.ObjectLockEnabled !== "Enabled"
    )
      throw new Error("Immutable custody check failed");
  } finally {
    a.destroy();
    b.destroy();
  }
  return {
    s3_endpoint: source,
    bucket: v.BACKUP_S3_BUCKET!,
    region: v.BACKUP_S3_REGION!,
    immutable_copy_confirmed: true,
  };
}

export async function bootstrapCidr() {
  const configured = await credential("FV_BOOTSTRAP_IPV4");
  const address =
    configured ??
    (await new Promise<string>((accept, reject) => {
      // Match the IPv4 route used for the initial pinned SSH session.
      const req = get(
        "https://www.cloudflare.com/cdn-cgi/trace",
        { family: 4, signal: AbortSignal.timeout(10_000) },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res
            .on("error", reject)
            .on("data", (chunk: string) => {
              body += chunk;
              if (body.length > 8192) req.destroy(new Error("Trace too large"));
            })
            .on("end", () =>
              res.statusCode === 200
                ? accept(/^ip=(.+)$/m.exec(body)?.[1] ?? "")
                : reject(new Error("Trace unavailable")),
            );
        },
      );
      req.on("error", reject);
    }));
  return z.ipv4().parse(address) + "/32";
}

const cloudflareGrants = new Set([
  "CF_READ_TOKEN",
  "CF_WRITE_TOKEN",
  "CLOUDFLARE_PROVISION_TOKEN",
  "FV_PAGES_API_TOKEN",
]);
const invalidCredential = /[\r\n\0]/;

export async function credentialPreflight(read = credential) {
  async function inspect(name: string) {
    try {
      const value = await read(name);
      if (!value) return "missing";
      return invalidCredential.test(value) ? "invalid" : "mounted";
    } catch {
      return "invalid";
    }
  }
  const issuerName = "FV_CF_TOKEN_ISSUER";
  const cloudflareIssuer = await inspect(issuerName);
  const mounted: string[] = [];
  const delegated: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = cloudflareIssuer === "invalid" ? [issuerName] : [];
  for (const name of [...operatorRequired, ...hostRequired]) {
    const state = await inspect(name);
    if (state === "mounted") mounted.push(name);
    else if (state === "invalid") invalid.push(name);
    else if (cloudflareIssuer === "mounted" && cloudflareGrants.has(name))
      delegated.push(name);
    else missing.push(name);
  }
  return {
    credentialProjectionComplete: missing.length === 0 && invalid.length === 0,
    cloudflareIssuer,
    mounted,
    delegated,
    missing,
    invalid,
  };
}

export async function loadInputs(issued: Record<string, string> = {}) {
  const values: Record<string, string> = {};
  for (const name of [
    ...hostRequired,
    ...hostOptional,
    ...operatorRequired,
    ...runtimePolicy,
  ]) {
    const supplied = await credential(name);
    if (issued[name] && supplied && issued[name] !== supplied)
      throw new BootstrapError(
        "The machine projection conflicts with the issued " +
          name +
          " binding.",
      );
    const value = supplied ?? issued[name];
    if (value) {
      if (invalidCredential.test(value))
        throw new BootstrapError("Invalid multiline value for " + name);
      values[name] = value;
    }
  }
  const missing = [...operatorRequired, ...hostRequired].filter(
    (key) => !values[key],
  );
  if (missing.length)
    throw new BootstrapError("Missing machine bindings: " + missing.join(", "));
  if (
    new Set([
      values.CF_READ_TOKEN,
      values.CF_WRITE_TOKEN,
      values.CLOUDFLARE_PROVISION_TOKEN,
      values.FV_PAGES_API_TOKEN,
    ]).size !== 4
  )
    throw new BootstrapError(
      "Cloudflare DNS, Pages and provisioning credentials require separate scopes.",
    );
  for (const name of ["ACCESS_ADMIN_EMAILS", "ACCESS_SSH_EMAILS"]) {
    if (values[name])
      z.array(z.email())
        .min(1)
        .parse(values[name].split(",").map((s) => s.trim()));
  }
  const host = Object.fromEntries(
    [...hostRequired, ...hostOptional]
      .filter((k) => values[k])
      .map((k) => [k, values[k]!]),
  );
  return { values, host };
}
export async function accountPin(root: string) {
  const file = join(root, ".state/operator/founder-cloudflare.private.json");
  const supplied = await credential("FV_CLOUDFLARE_ACCOUNT_ID");
  if (!(await exists(file)))
    return supplied ? accountId.parse(supplied) : undefined;
  const saved = z
    .object({
      account_id: accountId,
      zone_name: z.literal("foundervillage.org"),
    })
    .parse(JSON.parse(await privateText(file)));
  if (supplied && supplied !== saved.account_id)
    throw new Error("Account binding mismatch");
  return saved.account_id;
}
export async function launcherHash(root: string) {
  const launcher = join(root, "node_modules/cf/bin/cf");
  return stage(
    "The installed Cloudflare launcher differs from the locked release.",
    async () => {
      const tools = z
        .object({
          cf: z.object({ launcherSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
        })
        .parse(
          JSON.parse(
            await readFile(join(root, "config/tools.lock.json"), "utf8"),
          ),
        );
      const hash = digest(await readFile(launcher));
      if (hash !== tools.cf.launcherSha256)
        throw new Error("untrusted launcher");
      return hash;
    },
  );
}
