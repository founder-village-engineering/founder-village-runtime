import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { secret } from "../packages/database/index.ts";
import { Cloudflare } from "../packages/operations/cloudflare.ts";
import { boundedJson } from "../packages/observability/http.ts";
const file = process.argv[2] ?? "",
  action = z.enum(["plan", "apply"]).parse(process.argv[3]);
await promisify(execFile)("bin/fv", ["--config", file, "validate"], {
  timeout: 120000,
});
const config = z
  .object({
    environment: z.enum(["staging", "production"]),
    project: z.string().regex(/^[a-z0-9-]+$/),
    api_domain: z.string(),
    admin_domain: z.string(),
    cloudflare: z.object({
      account_id: z.string().regex(/^[a-f0-9]{32}$/),
      managed_names: z.array(z.string()),
    }),
  })
  .parse(JSON.parse(await readFile(file, "utf8")));
if (
  ![config.api_domain, config.admin_domain].every((n) =>
    config.cloudflare.managed_names.includes(n),
  )
)
  throw new Error("both ingress names must be explicitly managed");
const emails = z
  .array(z.email())
  .min(1)
  .parse(
    secret("ACCESS_ADMIN_EMAILS")
      .split(",")
      .map((s) => s.trim()),
  );
if (action === "plan") {
  console.log(
    JSON.stringify(
      {
        environment: config.environment,
        tunnel: config.project,
        ingress: [config.api_domain, config.admin_domain],
        adminMfa: true,
        administratorCount: emails.length,
        publicDatabases: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const account = config.cloudflare.account_id;
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${secret("CLOUDFLARE_PROVISION_TOKEN")}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    },
  );
  const data = z
    .object({ success: z.boolean(), result: z.unknown() })
    .parse(await boundedJson(response, 2 * 1024 * 1024));
  if (!response.ok || !data.success)
    throw new Error("Cloudflare provisioning failed");
  return data.result;
}
const tunnelSchema = z.object({ id: z.string().uuid(), name: z.string() });
const tunnels = z
  .array(tunnelSchema)
  .parse(
    await api(
      `cfd_tunnel?name=${encodeURIComponent(config.project)}&is_deleted=false`,
    ),
  );
if (tunnels.length > 1) throw new Error("ambiguous tunnel ownership");
const tunnel =
  tunnels[0] ??
  tunnelSchema.parse(
    await api("cfd_tunnel", "POST", {
      name: config.project,
      config_src: "cloudflare",
    }),
  );
await api(`cfd_tunnel/${tunnel.id}/configurations`, "PUT", {
  config: {
    ingress: [
      { hostname: config.api_domain, service: "http://caddy:8080" },
      { hostname: config.admin_domain, service: "http://caddy:8080" },
      { service: "http_status:404" },
    ],
  },
});
const token = z
  .string()
  .min(40)
  .max(8000)
  .parse(await api(`cfd_tunnel/${tunnel.id}/token`));
if (token.includes("\n")) throw new Error("invalid connector credential");
const envPath = `.state/${config.environment}.env`,
  env = (await readFile(envPath, "utf8"))
    .split("\n")
    .filter((line) => line && !line.startsWith("CLOUDFLARE_TUNNEL_TOKEN="));
await writeFile(
  `${envPath}.next`,
  env.join("\n") + `\nCLOUDFLARE_TUNNEL_TOKEN=${token}\n`,
  { mode: 0o600 },
);
await rename(`${envPath}.next`, envPath);
await mkdir(`.state/${config.environment}/tunnel`, {
  recursive: true,
  mode: 0o700,
});
await writeFile(`.state/${config.environment}/tunnel/token`, token, {
  mode: 0o600,
});
const appSchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().optional(),
  aud: z.string().optional(),
});
let apps: ReturnType<typeof appSchema.parse>[] = [];
for (let page = 1; page <= 100; page++) {
  const batch = z
    .array(appSchema)
    .parse(await api(`access/apps?page=${page}&per_page=100`));
  apps.push(...batch);
  if (batch.length < 100) break;
  if (page === 100) throw new Error("Access pagination exceeded");
}
const existing = apps.filter((a) => a.domain === config.admin_domain);
if (existing.length > 1) throw new Error("ambiguous Access applications");
if (existing[0] && existing[0].name !== `${config.project}-admin`)
  throw new Error("existing Access application requires explicit adoption");
const payload = {
  name: `${config.project}-admin`,
  domain: config.admin_domain,
  type: "self_hosted",
  session_duration: "1h",
  auto_redirect_to_identity: true,
};
const access = existing[0]
  ? appSchema.parse(await api(`access/apps/${existing[0].id}`, "PUT", payload))
  : appSchema.parse(await api("access/apps", "POST", payload));
const policies = z
  .array(z.object({ id: z.string(), name: z.string() }))
  .parse(await api(`access/apps/${access.id}/policies`));
if (policies.some((p) => p.name !== "fv-named-administrators"))
  throw new Error("unmanaged Access policy requires review");
const matches = policies.filter((p) => p.name === "fv-named-administrators");
if (matches.length > 1) throw new Error("ambiguous Access policy");
const policy = {
  name: "fv-named-administrators",
  decision: "allow",
  include: emails.map((email) => ({ email: { email } })),
  require: [{ auth_method: { auth_method: "mfa" } }],
  precedence: 1,
};
await api(
  `access/apps/${access.id}/policies${matches[0] ? `/${matches[0].id}` : ""}`,
  matches[0] ? "PUT" : "POST",
  policy,
);
const aud = z.string().min(1).parse(access.aud);
const document = JSON.parse(await readFile(file, "utf8")) as {
  cloudflare: { access_aud: string };
};
document.cloudflare.access_aud = aud;
await writeFile(file, JSON.stringify(document, null, 2) + "\n", {
  mode: 0o600,
});
const active = (await readFile(envPath, "utf8"))
  .split("\n")
  .filter((line) => line && !line.startsWith("ACCESS_AUD="));
await writeFile(envPath, active.join("\n") + `\nACCESS_AUD=${aud}\n`, {
  mode: 0o600,
});
const cf = new Cloudflare(true);
for (const name of [config.api_domain, config.admin_domain])
  await cf.apply(name, await cf.inventory(name), {
    name,
    type: "CNAME",
    content: `${tunnel.id}.cfargotunnel.com`,
    proxied: true,
    ttl: 300,
  });
console.log(
  JSON.stringify({
    event: "cloudflare.provisioned",
    environment: config.environment,
    ingressCount: 2,
    databasesPublic: false,
  }),
);
