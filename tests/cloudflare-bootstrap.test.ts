import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCloudflareCli } from "../packages/operations/cloudflare.ts";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const bootstrap = fileURLToPath(
  new URL("../scripts/cloudflare-bootstrap.ts", import.meta.url),
);
const id = "0".repeat(32);
const account = "1".repeat(32);
const zone = {
  id,
  name: "example.com",
  status: "active",
  account: { id: account },
};
const zoneGet = "zones get --zone " + id;
const api = "api.example.com",
  admin = "admin.example.com",
  vault = "vault.example.com";
const project = "fv-fixture",
  team = "fixture",
  audience = "synthetic-audience";
const tunnel = "11111111-2222-4333-8444-555555555555";
const appId = "22222222-3333-4444-8555-666666666666";
const email = "test@example.com";

// The pinned launcher receives only synthetic credentials. Unexpected commands fail.
const launcher = [
  'import {appendFileSync, readFileSync} from "node:fs";',
  'const args = process.argv.slice(2); const body = args.indexOf("--body");',
  'const key = (body < 0 ? args : args.slice(0, body)).join(" ");',
  'const tokens = JSON.parse(readFileSync("synthetic-roles", "utf8"));',
  "const role = Object.keys(tokens).find(r => process.env.CLOUDFLARE_API_TOKEN === tokens[r]);",
  'const previous = readFileSync("calls", "utf8").split("\\n");',
  'appendFileSync("calls", JSON.stringify({key,role})+"\\n");',
  'const fixture = JSON.parse(readFileSync("responses", "utf8"));',
  "const res = fixture[key]; if (!res || res.role !== role) process.exit(1);",
  "const repeated = previous.some(s => s && JSON.parse(s).key === key);",
  'console.log(JSON.stringify(repeated && "repeat" in res ? res.repeat : res.data));',
].join("\n");

function responses(apply: boolean) {
  const app = {
    id: appId,
    name: project + "-admin",
    domain: admin,
    type: "self_hosted",
    aud: audience,
    policies: [
      {
        name: "fv-named-administrators",
        decision: "allow",
        include: [{ email: { email } }],
        require: [{ auth_method: { auth_method: "mfa" } }],
      },
    ],
  };
  const routes = {
    config: {
      ingress: [
        { hostname: api, service: "http://caddy:8080" },
        {
          hostname: admin,
          service: "http://caddy:8080",
          originRequest: {
            access: { required: true, teamName: team, audTag: [audience] },
          },
        },
        { hostname: vault, service: "http://caddy:8080" },
        { service: "http_status:404" },
      ],
    },
  };
  const table: Record<
    string,
    { role: string; data: unknown; repeat?: unknown }
  > = {
    [zoneGet]: { role: "reader", data: zone },
    [`tunnels list --name ${project} --is-deleted=false --tun-types cfd_tunnel --per-page 100 --page 1`]:
      {
        role: "account",
        data: [{ id: tunnel, name: project, status: "healthy" }],
      },
    ["tunnels config get " + tunnel]: { role: "account", data: routes },
    [`zero-trust access applications list --domain ${admin} --exact --page 1 --per-page 100`]:
      { role: "account", data: [app] },
    ["zero-trust access applications get " + appId]: {
      role: "account",
      data: app,
    },
    ["tunnels config update " + tunnel]: { role: "account", data: {} },
    ["tunnels token get " + tunnel]: { role: "account", data: "x".repeat(48) },
  };
  for (const name of [api, admin, vault]) {
    table[
      `dns records list --zone ${id} --name ${name} --page 1 --per-page 100`
    ] = {
      role: apply ? "writer" : "reader",
      data: [
        {
          id: "synthetic",
          name,
          type: "CNAME",
          content: tunnel + ".cfargotunnel.com",
          proxied: true,
          ttl: 1,
        },
      ],
    };
  }
  return table;
}

test("Tunnel apply and verify bind existing routes to the active zone and its owner before any write", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fv-cf-zone-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(["bin", "work", ".state"].map((d) => mkdir(join(root, d))));
  await writeFile(join(root, "bin/fv"), '#!/bin/sh\n[ "$3" = validate ]\n', {
    mode: 0o700,
  });
  const cf = join(root, "fixture.ts"),
    manifest = join(root, "test-config.json"),
    calls = join(root, "work/calls");
  await writeFile(cf, launcher);
  const document = {
    project,
    environment: "staging",
    api_domain: api,
    admin_domain: admin,
    vaultwarden_domain: vault,
    provider: {},
    cloudflare: {
      account_id: account,
      zone_id: id,
      zone_name: zone.name,
      access_team: team,
      access_aud: audience,
      cf_binary: cf,
      cf_sha256: createHash("sha256").update(launcher).digest("hex"),
      managed_names: [api, admin, vault],
    },
  };
  await writeFile(manifest, JSON.stringify(document), { mode: 0o600 });
  await writeFile(join(root, ".state/staging.env"), "");
  const tokens = {
    reader: randomUUID(),
    writer: randomUUID(),
    account: randomUUID(),
  };
  await writeFile(join(root, "work/synthetic-roles"), JSON.stringify(tokens), {
    mode: 0o600,
  });
  const env = {
    HOME: root,
    PATH: "/usr/bin:/bin",
    CF_WORK_DIR: join(root, "work"),
    CF_READ_TOKEN: tokens.reader,
    CF_WRITE_TOKEN: tokens.writer,
    CLOUDFLARE_PROVISION_TOKEN: tokens.account,
    ACCESS_ADMIN_EMAILS: email,
  };
  async function run(
    action: "apply" | "verify",
    fixture: ReturnType<typeof responses>,
    succeeds: boolean,
  ) {
    await writeFile(join(root, "work/responses"), JSON.stringify(fixture));
    await writeFile(calls, "");
    const op = exec(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), bootstrap, manifest, action],
      { cwd: root, env, timeout: 15000 },
    );
    if (succeeds) await op;
    else await assert.rejects(op);
    return (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s) as { key: string; role: string });
  }

  for (const [profile, selectedAccount] of [
    ["archlife", account],
    ["foundervillage", "a".repeat(32)],
  ]) {
    await writeFile(calls, "");
    await assert.rejects(
      exec(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), bootstrap, manifest, "apply"],
        {
          cwd: root,
          env: {
            ...env,
            CLOUDFLARE_AUTH_PROFILE: profile,
            CLOUDFLARE_ACCOUNT_ID: selectedAccount,
          },
          timeout: 15000,
        },
      ),
    );
    assert.equal(await readFile(calls, "utf8"), "");
  }

  for (const action of ["apply", "verify"] as const) {
    for (const value of [
      { ...zone, id: "2".repeat(32) },
      { ...zone, name: "another.example" },
      { ...zone, status: "pending" },
      { ...zone, account: { id: "3".repeat(32) } },
      { ...zone, account: {} },
      null,
    ]) {
      const fixture = responses(action === "apply");
      if (value === null)
        delete fixture[zoneGet]; // Zone Read denied
      else fixture[zoneGet] = { role: "reader", data: value };
      assert.deepEqual(await run(action, fixture, false), [
        { key: zoneGet, role: "reader" },
      ]);
    }
    const successful = await run(action, responses(action === "apply"), true);
    assert.deepEqual(successful[0], { key: zoneGet, role: "reader" });
    const writes = successful.filter(({ key }) =>
      / (?:create|delete|update)\b/.test(key),
    );
    assert.deepEqual(
      writes,
      action === "apply"
        ? [{ key: "tunnels config update " + tunnel, role: "account" }]
        : [],
    );
  }

  const changed = responses(true);
  changed[zoneGet]!.repeat = { ...zone, account: { id: "3".repeat(32) } };
  const attempts = await run("apply", changed, false);
  assert(attempts.length > 1);
  assert.equal(attempts.at(-1)?.key, zoneGet);
  assert(!attempts.some(({ key }) => / (?:create|delete|update)\b/.test(key)));

  const nativeCalls = join(root, "work/profile-calls");
  const pinned = join(root, "node_modules/cf/bin/cf");
  await mkdir(join(root, "node_modules/cf/bin"), { recursive: true });
  const data = Object.fromEntries(
    Object.entries(responses(true)).map(([key, entry]) => [key, entry.data]),
  );
  const nativeLauncher = [
    'const {appendFileSync}=require("node:fs");',
    "const args=process.argv.slice(2);",
    'if(args.splice(-2).join(" ")!=="--profile foundervillage" || process.env.CLOUDFLARE_API_TOKEN) process.exit(2);',
    'const body=args.indexOf("--body");',
    'const key=(body<0?args:args.slice(0,body)).join(" ");',
    "appendFileSync(" + JSON.stringify(nativeCalls) + ',key+"\\n");',
    "const data=" + JSON.stringify(data) + ";",
    "if(!(key in data))process.exit(1); console.log(JSON.stringify(data[key]));",
  ].join("\n");
  await writeFile(pinned, nativeLauncher);
  document.cloudflare.cf_sha256 = createHash("sha256")
    .update(nativeLauncher)
    .digest("hex");
  await writeFile(manifest, JSON.stringify(document));
  await rm(join(root, ".state/staging.env"));
  await exec(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), bootstrap, manifest, "apply"],
    {
      cwd: root,
      timeout: 15000,
      env: {
        HOME: root,
        PATH: "/usr/bin:/bin",
        CLOUDFLARE_AUTH_PROFILE: "foundervillage",
        CLOUDFLARE_ACCOUNT_ID: account,
        ACCESS_ADMIN_EMAILS: email,
        CF_ACCOUNT_ID_FILE: join(root, "invalid"),
        CLOUDFLARE_API_TOKEN: randomUUID(),
      },
    },
  );
  assert((await readFile(nativeCalls, "utf8")).startsWith(zoneGet + "\n"));
  const credential = join(
    root,
    ".state/operator/cloudflare/staging/connector.token",
  );
  assert.equal((await stat(credential)).mode & 0o777, 0o600);
  assert.equal(
    await readFile(credential, "utf8"),
    data["tunnels token get " + tunnel],
  );
  assert.equal(
    JSON.parse(await readFile(manifest, "utf8")).cloudflare.access_aud,
    audience,
  );
  await assert.rejects(stat(join(root, ".state/staging.env")), {
    code: "ENOENT",
  });
});

test("named workstation CLI uses its private session in a clean directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fv-cf-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "cf.mjs");
  const fixture = [
    'import { existsSync } from "node:fs";',
    "const env = process.env;",
    "console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),",
    '  dotenv: existsSync(".env"), token: Boolean(env.CLOUDFLARE_API_TOKEN),',
    "  configHome: env.XDG_CONFIG_HOME, cacheHome: env.XDG_CACHE_HOME,",
    "  keyring: env.CLOUDFLARE_AUTH_USE_KEYRING, account: env.CLOUDFLARE_ACCOUNT_ID,",
    "  endpoint: env.CLOUDFLARE_API_BASE_URL }));",
  ].join("\n");
  await writeFile(path, fixture, { mode: 0o600 });
  await writeFile(
    join(root, ".env"),
    "CLOUDFLARE_API_TOKEN=" + randomUUID() + "\n",
  );
  const settings = {
    CF_BINARY: path,
    CF_SHA256: createHash("sha256").update(fixture).digest("hex"),
    CF_ACCOUNT_ID: account,
    CF_WORK_DIR: root,
    CLOUDFLARE_API_TOKEN: randomUUID(),
    CLOUDFLARE_API_BASE_URL: "https://unused.invalid",
    XDG_CONFIG_HOME: join(root, "configuration"),
    XDG_CACHE_HOME: join(root, "cache"),
    CLOUDFLARE_AUTH_USE_KEYRING: "false",
  };
  for (const [name, value] of Object.entries(settings)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    process.env[name] = value;
  }
  const args = ["zones", "get", "--zone", id];
  const result = (await runCloudflareCli(args, {
    profile: "foundervillage",
  })) as Record<string, unknown>;
  const { cwd, ...observed } = result;
  assert.notEqual(cwd, root);
  assert.notEqual(cwd, process.cwd());
  await assert.rejects(readFile(cwd as string), { code: "ENOENT" });
  assert.deepEqual(observed, {
    args: [...args, "--profile", "foundervillage"],
    dotenv: false,
    token: false,
    configHome: settings.XDG_CONFIG_HOME,
    cacheHome: settings.XDG_CACHE_HOME,
    keyring: "false",
    account,
    endpoint: "https://api.cloudflare.com/client/v4",
  });
});
