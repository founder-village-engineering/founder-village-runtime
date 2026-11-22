import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { secret } from "../packages/database/index.ts";
import {
  Cloudflare,
  fingerprint,
  runCloudflareCli,
} from "../packages/operations/cloudflare.ts";

const appSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  domain: z.string().optional(),
  aud: z.string().min(1).optional(),
  type: z.string(),
  policies: z
    .array(
      z.object({
        name: z.string(),
        decision: z.string(),
        include: z.array(z.unknown()),
        require: z.array(z.unknown()).default([]),
        exclude: z.array(z.unknown()).default([]),
      }),
    )
    .nullish(),
});
const routesSchema = z.object({
  config: z
    .object({
      ingress: z
        .array(
          z.object({
            hostname: z.string().optional(),
            path: z.string().optional(),
            service: z.string(),
            originRequest: z
              .object({
                access: z
                  .object({
                    required: z.boolean(),
                    teamName: z.string(),
                    audTag: z.array(z.string()),
                  })
                  .optional(),
              })
              .optional(),
          }),
        )
        .nullish(),
      "warp-routing": z.object({ enabled: z.boolean() }).optional(),
    })
    .nullish(),
});
const tunnelSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.string().optional(),
});

function emailList(value: string) {
  return [
    ...new Set(
      z
        .array(z.email())
        .min(1)
        .parse(value.split(",").map((email) => email.trim().toLowerCase())),
    ),
  ];
}

let step = "validate private runtime configuration";
try {
  const file = process.argv[2] ?? "";
  const action = z.enum(["plan", "apply", "verify"]).parse(process.argv[3]);
  await promisify(execFile)("bin/fv", ["--config", file, "validate"], {
    timeout: 120_000,
  });
  const original = await readFile(file, "utf8");
  const document = JSON.parse(original) as Record<string, unknown>;
  const config = z
    .object({
      project: z.string(),
      environment: z.enum(["staging", "production"]),
      api_domain: z.string(),
      admin_domain: z.string(),
      provider: z.object({
        existing_server: z.object({ ipv4: z.ipv4() }).optional(),
      }),
      cloudflare: z.object({
        account_id: z.string(),
        zone_id: z.string(),
        zone_name: z.string(),
        access_team: z.string(),
        access_aud: z.string(),
        cf_binary: z.string(),
        cf_sha256: z.string(),
        managed_names: z.array(z.string()),
        ssh_domain: z.string().nullish(),
      }),
    })
    .parse(document);
  const ssh = config.cloudflare.ssh_domain;
  const hosts = [
    { role: "api", hostname: config.api_domain, service: "http://caddy:8080" },
    {
      role: "admin",
      hostname: config.admin_domain,
      service: "http://caddy:8080",
    },
    ...(ssh
      ? [{ role: "ssh", hostname: ssh, service: "ssh://fv-operator:22" }]
      : []),
  ];
  const names = hosts.map(({ hostname }) => hostname);
  if (!names.every((name) => config.cloudflare.managed_names.includes(name)))
    throw new Error("tunnel hostnames must be explicitly managed");
  if (action === "plan") {
    console.log(
      JSON.stringify(
        {
          environment: config.environment,
          tunnel: config.project,
          ingress: hosts,
          administrativeMfa: true,
          publicOriginRecords: false,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  const meta = await lstat(file);
  if (!meta.isFile() || (meta.mode & 0o077) !== 0)
    throw new Error("private manifest required");

  const verifyOnly = action === "verify";
  const admins = emailList(secret("ACCESS_ADMIN_EMAILS"));
  const operators = ssh ? emailList(secret("ACCESS_SSH_EMAILS")) : [];
  // Bind every invocation to the validated account, zone, and checksum.
  Object.assign(process.env, {
    CF_BINARY: config.cloudflare.cf_binary,
    CF_SHA256: config.cloudflare.cf_sha256,
    CF_ACCOUNT_ID: config.cloudflare.account_id,
    CF_ZONE_ID: config.cloudflare.zone_id,
    CF_ZONE_NAME: config.cloudflare.zone_name,
    CF_MANAGED_NAMES: config.cloudflare.managed_names.join(","),
    CF_TUNNEL_NAMES: names.join(","),
  });
  const token = secret("CLOUDFLARE_PROVISION_TOKEN");
  const accountCli = (args: string[]) => runCloudflareCli(args, token);
  async function write(args: string[], body: object) {
    const working = path.resolve(secret("CF_WORK_DIR"));
    await mkdir(working, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(path.join(working, "fv-cf-request-"));
    const input = path.join(dir, "body.json");
    try {
      await writeFile(input, JSON.stringify(body), { mode: 0o600, flag: "wx" });
      return await accountCli([...args, "--body", `@${input}`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  step = "check DNS for direct origin records and conflicting routes";
  const cf = new Cloudflare(!verifyOnly);
  const origin = config.provider.existing_server?.ipv4;
  if (origin) {
    const matches = z
      .array(z.unknown())
      .parse(
        await cf.call([
          "dns",
          "records",
          "list",
          "--zone",
          config.cloudflare.zone_id,
          "--content-contains",
          origin,
          "--per-page",
          "1",
        ]),
      );
    if (matches.length)
      throw new Error("zone DNS contains the configured origin IPv4");
  }
  const records = await Promise.all(names.map((name) => cf.inventory(name)));
  step = "check ownership of the named Cloudflare Tunnel";
  const tunnels = z
    .array(tunnelSchema)
    .max(1)
    .parse(
      await accountCli([
        "tunnels",
        "list",
        "--name",
        config.project,
        "--is-deleted=false",
        "--tun-types",
        "cfd_tunnel",
        "--per-page",
        "100",
        "--page",
        "1",
      ]),
    );
  const existing = tunnels[0];
  if (existing && existing.name !== config.project)
    throw new Error("unexpected tunnel selection");
  if (
    records.some(
      (record) =>
        record &&
        (record.type !== "CNAME" ||
          record.content !== `${existing?.id}.cfargotunnel.com`),
    )
  )
    throw new Error("existing DNS records require explicit review");
  if (existing) {
    const current = routesSchema.parse(
      await accountCli(["tunnels", "config", "get", existing.id]),
    ).config;
    if (
      current?.["warp-routing"]?.enabled ||
      current?.ingress?.some(
        ({ hostname, service, path }) =>
          path ||
          (hostname
            ? !hosts.some(
                (host) =>
                  host.hostname === hostname && host.service === service,
              )
            : service !== "http_status:404"),
      )
    )
      throw new Error("existing tunnel routes require explicit review");
  }

  async function accessApp(hostname: string, role: string, emails: string[]) {
    const command = ["zero-trust", "access", "applications"];
    const name = `${config.project}-${role}`;
    const policy = {
      name:
        role === "admin" ? "fv-named-administrators" : "fv-named-ssh-operators",
      decision: "allow",
      include: emails.map((email) => ({ email: { email } })),
      require: [{ auth_method: { auth_method: "mfa" } }],
      precedence: 1,
    };
    const matches = z
      .array(appSchema)
      .max(1)
      .parse(
        await accountCli([
          ...command,
          "list",
          "--domain",
          hostname,
          "--exact",
          "--page",
          "1",
          "--per-page",
          "100",
        ]),
      );
    const match = matches[0];
    if (
      match &&
      (match.name !== name ||
        match.domain !== hostname ||
        match.type !== "self_hosted")
    )
      throw new Error("existing Access application requires review");
    if (!match && verifyOnly) throw new Error("missing Access application");
    const id =
      match?.id ??
      appSchema.parse(
        await write([...command, "create"], {
          name,
          domain: hostname,
          type: "self_hosted",
          session_duration: "1h",
          app_launcher_visible: false,
          policies: [policy],
        }),
      ).id;
    const app = appSchema.parse(await accountCli([...command, "get", id]));
    const [checked, ...others] = app.policies ?? [];
    if (
      app.name !== name ||
      app.domain !== hostname ||
      app.type !== "self_hosted" ||
      !checked ||
      others.length ||
      checked.name !== policy.name ||
      checked.decision !== "allow" ||
      checked.exclude.length ||
      fingerprint(checked.require) !== fingerprint(policy.require) ||
      checked.include.map(fingerprint).sort().join() !==
        policy.include.map(fingerprint).sort().join()
    )
      throw new Error("Access policy verification failed");
    return z.string().min(1).parse(app.aud);
  }

  step = "converge and verify the named administrator and SSH Access policies";
  const aud = await accessApp(config.admin_domain, "admin", admins);
  const sshAud = ssh ? await accessApp(ssh, "ssh", operators) : undefined;
  step = "converge and verify the Cloudflare Tunnel routes";
  if (verifyOnly && !existing) throw new Error("missing Cloudflare Tunnel");
  const tunnel =
    existing ??
    tunnelSchema.parse(
      await write(["tunnels", "create"], {
        name: config.project,
        config_src: "cloudflare",
      }),
    );
  if (tunnel.name !== config.project) throw new Error("unexpected tunnel name");
  const routes = [
    ...hosts.map(({ role, hostname, service }) => {
      const audience =
        role === "admin" ? aud : role === "ssh" ? sshAud : undefined;
      return {
        hostname,
        service,
        ...(audience
          ? {
              originRequest: {
                access: {
                  required: true,
                  teamName: config.cloudflare.access_team,
                  audTag: [audience],
                },
              },
            }
          : {}),
      };
    }),
    {
      service: "http_status:404",
      hostname: undefined,
      originRequest: undefined,
    },
  ];
  if (!verifyOnly)
    await write(["tunnels", "config", "update", tunnel.id], {
      config: { ingress: routes },
    });
  const configured = routesSchema.parse(
    await accountCli(["tunnels", "config", "get", tunnel.id]),
  ).config;
  const ingress = configured?.ingress;
  if (
    configured?.["warp-routing"]?.enabled ||
    ingress?.length !== routes.length ||
    ingress.some((actual, index) => {
      const expected = routes[index]!;
      return (
        (actual.hostname || undefined) !== expected.hostname ||
        actual.service !== expected.service ||
        actual.path ||
        fingerprint(actual.originRequest?.access ?? null) !==
          fingerprint(expected.originRequest?.access ?? null)
      );
    })
  )
    throw new Error("tunnel route verification failed");

  step = "converge and read back proxied CNAME records";
  for (const [index, name] of names.entries())
    await cf.ensureTunnelRecord(
      name,
      tunnel.id,
      records[index] ?? null,
      verifyOnly,
    );
  if (verifyOnly) {
    step = "verify the active connector and configured Access audience";
    if (
      !["healthy", "degraded"].includes(tunnel.status ?? "") ||
      config.cloudflare.access_aud !== aud
    )
      throw new Error("tunnel connector or Access audience not ready");
  } else {
    step = "install the protected connector credential and Access audience";
    const connector = z
      .string()
      .min(40)
      .max(8000)
      .regex(/^[A-Za-z0-9_+/=-]+$/)
      .parse(await accountCli(["tunnels", "token", "get", tunnel.id]));
    const envPath = `.state/${config.environment}.env`;
    const state = `.state/${config.environment}/tunnel`;
    const active = (await readFile(envPath, "utf8"))
      .split("\n")
      .filter(
        (line) =>
          line &&
          !line.startsWith("ACCESS_AUD=") &&
          !line.startsWith("CLOUDFLARE_TUNNEL_TOKEN="),
      );
    async function publish(destination: string, value: string) {
      const temp = `${destination}.${randomUUID()}.next`;
      await writeFile(temp, value, { mode: 0o600, flag: "wx" });
      await rename(temp, destination);
    }
    if ((await readFile(file, "utf8")) !== original)
      throw new Error("manifest changed during bootstrap");
    document.cloudflare = {
      ...(document.cloudflare as object),
      access_aud: aud,
    };
    await publish(file, JSON.stringify(document, null, 2) + "\n");
    await mkdir(state, { recursive: true, mode: 0o700 });
    await publish(`${state}/token`, connector);
    await publish(
      envPath,
      active.join("\n") +
        `\nACCESS_AUD=${aud}\nCLOUDFLARE_TUNNEL_TOKEN=${connector}\n`,
    );
  }
  console.log(
    JSON.stringify({
      event: verifyOnly ? "cloudflare.verified" : "cloudflare.provisioned",
      environment: config.environment,
      ingressCount: names.length,
    }),
  );
} catch {
  console.error(`Cloudflare Tunnel workflow failed during ${step}.`);
  process.exitCode = 1;
}
