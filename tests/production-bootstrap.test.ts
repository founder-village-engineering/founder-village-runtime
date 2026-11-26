import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { prepare } from "../scripts/production-bootstrap.ts";
import { accessPolicies, machineAccess } from "../scripts/production/access.ts";
import { deploy } from "../scripts/production/deploy.ts";
import { checkGrantPlan } from "../scripts/production/authority.ts";
import {
  credentialPreflight,
  type CfRequest,
} from "../scripts/production/discovery.ts";
import {
  credential,
  exists,
  identities,
  privateText,
  publish,
  run,
  useVaultwardenBindings,
} from "../scripts/production/workstation.ts";

test("credential preflight reports absent, unreadable and delegated grants by name", async () => {
  const fixtureSecret = randomUUID();
  const result = await credentialPreflight(async (name) => {
    if (name === "FV_CF_TOKEN_ISSUER" || name === "OIDC_CLIENT_ID")
      return fixtureSecret;
    if (name === "FV_PAGES_API_TOKEN") throw new Error(fixtureSecret);
    return undefined;
  });
  assert.equal(result.credentialProjectionComplete, false);
  assert.deepEqual(result.invalid, ["FV_PAGES_API_TOKEN"]);
  assert.deepEqual(result.mounted, ["OIDC_CLIENT_ID"]);
  assert.deepEqual(result.delegated, [
    "CLOUDFLARE_PROVISION_TOKEN",
    "CF_READ_TOKEN",
    "CF_WRITE_TOKEN",
  ]);
  assert.ok(result.missing.includes("FV_HCLOUD_TOKEN"));
  assert.ok(result.missing.includes("IMMUTABLE_ACCESS_KEY"));
  assert.ok(!JSON.stringify(result).includes(fixtureSecret));

  const complete = await credentialPreflight(async (name) =>
    name === "FV_CF_TOKEN_ISSUER" ? undefined : "fixture-" + name,
  );
  assert.equal(complete.credentialProjectionComplete, true);
  assert.deepEqual(complete.delegated, []);
  assert.deepEqual(complete.missing, []);
});

test("preflight accepts Vaultwarden bindings and rejects conflicting file projections", async () => {
  const name = "FV_HCLOUD_TOKEN";
  const value = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), "fv-vault-bindings-"));
  const previous = process.env;
  process.env = { CREDENTIALS_DIRECTORY: directory };
  useVaultwardenBindings(new Map([[name, value]]));
  try {
    assert.equal(await credential(name), value);
    assert.deepEqual((await credentialPreflight()).mounted, [name]);
    await publish(join(directory, name), randomUUID() + "\n");
    const drift = await credentialPreflight();
    assert.deepEqual(drift.invalid, [name]);
    assert.ok(!JSON.stringify(drift).includes(value));
  } finally {
    useVaultwardenBindings(new Map());
    process.env = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepare and apply stop at the shared preflight before building or enrolling identities", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "fv-bootstrap-gate-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workstation = join(temp, "workstation");
  const credentials = join(temp, "credentials");
  await mkdir(credentials, { mode: 0o700 });
  const issuer = randomUUID();
  await publish(join(credentials, "FV_CF_TOKEN_ISSUER"), issuer);
  for (const action of ["prepare", "apply"]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/production-entry.ts", action],
      {
        encoding: "utf8",
        env: {
          HOME: temp,
          PATH: temp,
          CREDENTIALS_DIRECTORY: credentials,
          FV_PRODUCTION_HOME: workstation,
        },
      },
    );
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.credentialProjectionComplete, false);
    assert.ok(report.missing.includes("OIDC_CLIENT_ID"));
    assert.ok(report.delegated.includes("FV_PAGES_API_TOKEN"));
    assert.ok(!(result.stdout + result.stderr).includes(issuer));
    assert.equal(await exists(workstation), false);
  }
});

test("The deployment token grants only SSH and admin retains named MFA", () => {
  const token = randomUUID(),
    emails = ["admin@example.test"];
  const admin = accessPolicies("admin", emails, token);
  assert.equal(admin.machine, undefined);
  assert.deepEqual(
    admin.policies.map((p) => [p.decision, p.include, p.require]),
    [
      [
        "allow",
        [{ email: { email: emails[0] } }],
        [{ auth_method: { auth_method: "mfa" } }],
      ],
    ],
  );
  for (const allowed of [[], emails]) {
    const ssh = accessPolicies("ssh", allowed, token);
    assert.equal(ssh.policies.length, allowed.length + 1);
    assert.equal(ssh.machine?.decision, "non_identity");
    assert.deepEqual(ssh.machine?.include, [
      { service_token: { token_id: token } },
    ]);
    assert.equal(ssh.machine?.precedence, allowed.length + 1);
  }
  assert.throws(() => accessPolicies("admin", [], token));
});

async function deploymentFixture(
  checkout: string,
  source: string,
  prepared: Awaited<ReturnType<typeof prepare>>,
) {
  const frontend = join(checkout, "../founder-village-frontends");
  await mkdir(join(frontend, "node_modules/.bin"), { recursive: true });
  await writeFile(join(frontend, "node_modules/.bin/wrangler"), "");
  await run("git", ["-C", frontend, "init", "-q"]);
  await writeFile(join(frontend, ".git/info/exclude"), "node_modules/\n");
  await run("git", [
    "-C",
    frontend,
    "remote",
    "add",
    "origin",
    "https://github.com/founder-village-engineering/founder-village-frontends.git",
  ]);
  await run("git", [
    "-C",
    frontend,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Fixture",
    "--allow-empty",
  ]);
  await writeFile(
    join(checkout, ".git/info/exclude"),
    "/bin/\n/config/\n/node_modules/\n/scripts/\n/package.json\n",
  );
  await writeFile(join(checkout, "package.json"), '{"type":"module"}');
  await symlink(
    join(source, "node_modules/tsx"),
    join(checkout, "node_modules/tsx"),
  );
  const scripts = join(checkout, "scripts");
  await mkdir(scripts);
  const trace =
    'import { appendFileSync } from "node:fs"; const record = (line: string) => appendFileSync("../trace", line + "\\n");\n';
  await writeFile(
    join(scripts, "cloudflare-bootstrap.ts"),
    trace +
      [
        'import { mkdirSync, readFileSync, writeFileSync } from "node:fs"; import { join } from "node:path";',
        'const [file, action] = process.argv.slice(2); record("cf " + action);',
        "if (!process.env.FV_SSH_ACCESS_TOKEN_ID || process.env.FV_HCLOUD_TOKEN) throw new Error();",
        'if (action === "apply") { const m = JSON.parse(readFileSync(file, "utf8"));',
        'm.cloudflare.access_aud = "fixture-audience"; writeFileSync(file, JSON.stringify(m));',
        'const dir = join(process.env.CF_WORK_DIR, "production"); mkdirSync(dir,{recursive:true});',
        'writeFileSync(join(dir, "connector.token"), "c".repeat(50), {mode:0o600}); }',
      ].join("\n"),
  );
  await writeFile(
    join(scripts, "remote-bootstrap.ts"),
    trace +
      [
        'import { readFileSync } from "node:fs"; const settings = JSON.parse(readFileSync(process.argv[2],"utf8"));',
        'const tunneled = settings.host === "ssh.foundervillage.org";',
        "if (tunneled !== Boolean(process.env.TUNNEL_SERVICE_TOKEN_SECRET) || process.env.FV_HCLOUD_TOKEN) throw new Error();",
        'record("install " + (tunneled ? "tunnel" : "direct"));',
      ].join("\n"),
  );
  await writeFile(
    join(scripts, "probe.ts"),
    trace +
      'if (!process.env.PUBLIC_API_REVISION) throw new Error(); record("public api");',
  );
  await writeFile(
    join(scripts, "frontend-production.ts"),
    trace +
      [
        'const action=process.argv[2]; if ((action !== "verify") !== Boolean(process.env.CLOUDFLARE_API_TOKEN) || process.env.FV_HCLOUD_TOKEN) throw new Error();',
        'record("pages " + action);',
      ].join("\n"),
  );
  await writeFile(
    join(checkout, "bin/ssh"),
    [
      "#!/bin/sh",
      "set -eu",
      "for arg do cmd=$arg; done",
      'test -z "${FV_HCLOUD_TOKEN:-}${CLOUDFLARE_PROVISION_TOKEN:-}"',
      'case "$cmd" in',
      '*escrow-backup-verifier) echo \'{"fingerprint":"' +
        "a".repeat(64) +
        '","encrypted":"-----BEGIN AGE ENCRYPTED FILE-----fixture-----END AGE ENCRYPTED FILE-----"}\' ;;',
      "*install-catalog) cat >/dev/null ;;",
      '*seal-ssh) test -n "${TUNNEL_SERVICE_TOKEN_SECRET:-}"; echo "host close" >> ../trace ;;',
      '"sudo -n true") test -n "${TUNNEL_SERVICE_TOKEN_SECRET:-}"; echo "tunnel ssh" >> ../trace ;;',
      "esac",
    ].join("\n"),
    { mode: 0o700 },
  );
  process.env.PATH = join(checkout, "bin") + ":" + process.env.PATH;
  await mkdir(prepared.releaseDir, { recursive: true });
  const release = join(prepared.releaseDir, "source-manifest.json");
  await writeFile(
    release,
    JSON.stringify({
      version: 3,
      architecture: prepared.manifest.provider.architecture,
      revision: prepared.revision,
      distribution: "workstation",
    }),
  );
  await run("ssh-keygen", [
    "-Y",
    "sign",
    "-f",
    prepared.keys.signer,
    "-n",
    "fv-release-v3",
    release,
  ]);
}

test("A machine generates a complete private production profile and reuses trust across retries", async (t) => {
  const original = process.cwd(),
    priorEnv = process.env;
  const temp = await mkdtemp(join(tmpdir(), "fv-production-test-")),
    home = join(temp, "machine"),
    creds = join(temp, "credentials");
  const checkout = join(temp, "checkout");
  t.after(async () => {
    process.chdir(original);
    process.env = priorEnv;
    await rm(temp, { force: true, recursive: true });
  });
  for (const dir of [
    home,
    creds,
    join(checkout, "config"),
    join(checkout, "bin"),
    join(checkout, "node_modules/cf/bin"),
  ])
    await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const file of [
    "config/production.example.json",
    "config/tools.lock.json",
    "node_modules/cf/bin/cf",
  ])
    await copyFile(join(original, file), join(checkout, file));
  process.env = {
    PATH: priorEnv.PATH,
    HOME: temp,
    CREDENTIALS_DIRECTORY: creds,
  };
  process.chdir(checkout);
  await run("git", ["init", "-q"]);
  await run("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Fixture",
    "--allow-empty",
  ]);
  const issuer = "https://id.example.test";
  const inputs = {
    FV_HCLOUD_TOKEN: randomUUID(),
    CF_READ_TOKEN: randomUUID(),
    CF_WRITE_TOKEN: randomUUID(),
    FV_PAGES_API_TOKEN: randomUUID(),
    CLOUDFLARE_PROVISION_TOKEN: randomUUID(),
    ACCESS_ADMIN_EMAILS: "admin@example.test",
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: "admin-client",
    OIDC_AUDIENCE: "api",
    FV_APP_OIDC_CLIENT_ID: "app-client",
    OIDC_MFA_ACR: "urn:test:mfa",
    FV_BOOTSTRAP_IPV4: "192.0.2.20",
    BACKUP_S3_ENDPOINT: "https://s3.example.test",
    BACKUP_S3_BUCKET: "primary",
    BACKUP_S3_REGION: "fixture",
    BACKUP_S3_KEY: randomUUID(),
    BACKUP_S3_SECRET: randomUUID(),
    IMMUTABLE_ENDPOINT: "https://s3.example.test",
    IMMUTABLE_REGION: "fixture",
    IMMUTABLE_BUCKET: "mirror",
    IMMUTABLE_ACCESS_KEY: randomUUID(),
    IMMUTABLE_SECRET_KEY: randomUUID(),
    AUDIT_ENDPOINT: "https://s3.example.test",
    AUDIT_BUCKET: "audit",
    AUDIT_REGION: "fixture",
    AUDIT_ACCESS_KEY: randomUUID(),
    AUDIT_SECRET_KEY: randomUUID(),
  };
  for (const [key, value] of Object.entries(inputs))
    await publish(join(creds, key), value);
  await writeFile(
    join(checkout, "bin/fv"),
    [
      "#!/bin/sh",
      "set -eu",
      'case "$3" in',
      'candidate-audit) echo \'{"project_isolated":true,"running":true,"image":"ubuntu-26.04"}\' ;;',
      "validate) exit 0 ;;",
      'provision) test -n "$FV_HCLOUD_TOKEN"; case "$4" in',
      'status) sealed=false; test ! -e ../provider-sealed || sealed=true; echo "{\\"project_isolated\\":true,\\"public_inbound_closed\\":$sealed,\\"owned\\":true,\\"firewall_rules_match\\":$sealed}" ;;',
      'apply) if test "$#" -eq 4; then echo "provider open" >> ../trace; else',
      'test -n "$TUNNEL_SERVICE_TOKEN_SECRET"; echo "provider close" >> ../trace;',
      "if test ! -e ../close-attempt; then touch ../close-attempt; exit 1; fi; touch ../provider-sealed; fi ;;",
      "*) exit 1 ;; esac ;;",
      "*) exit 1 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o700 },
  );
  const keys = await identities(home),
    again = await identities(home);
  assert.deepEqual(again, keys);
  assert.notEqual(
    await privateText(keys.operator),
    await privateText(keys.signer),
  );
  const hostKey = join(temp, "host");
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
  const raw = Buffer.from(
    (await readFile(hostKey + ".pub", "utf8")).split(" ")[1]!,
    "base64",
  )
    .subarray(19)
    .toString("hex");
  const cfAccount = "a".repeat(32);
  let conflictingZone = false,
    objectLock = true;
  let service: Record<string, string> | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string, init: RequestInit) => {
      const u = new URL(input);
      if (u.hostname === "admin.foundervillage.org") {
        assert.equal(init.redirect, "manual");
        return Response.redirect(
          "https://fixture.cloudflareaccess.com/cdn-cgi/access/login/admin.foundervillage.org",
          302,
        );
      }
      if (u.hostname === "vault.foundervillage.org") {
        assert.equal(init.redirect, "error");
        assert(["/alive", "/admin"].includes(u.pathname));
        return new Response(null, {
          status: u.pathname === "/alive" ? 200 : 404,
          headers: { "cache-control": "no-store" },
        });
      }
      if (
        u.hostname === "api.cloudflare.com" &&
        u.pathname.endsWith("/access/service_tokens")
      ) {
        if (init.method === "POST") {
          assert(!service);
          service = {
            name: JSON.parse(init.body as string).name,
            id: randomUUID(),
            client_id: "fixture.access",
            expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
          };
          return Response.json({
            success: true,
            result: { ...service, client_secret: randomUUID() },
          });
        }
        return Response.json({
          success: true,
          result: service ? [service] : [],
        });
      }
      assert(["GET", undefined].includes(init.method));
      assert.equal(init.redirect, "error");
      if (
        u.hostname === "api.hetzner.cloud" &&
        u.searchParams.get("name") === "fv-production"
      )
        return Response.json({
          servers: [
            {
              id: 99,
              name: "fv-production",
              labels: {
                "fv-owner": "fv-production",
                "fv-ssh-host-key-1": raw.slice(0, 32),
                "fv-ssh-host-key-2": raw.slice(32),
              },
              public_net: { ipv4: { ip: "192.0.2.5" } },
              location: { name: "hel1" },
              image: { name: "ubuntu-26.04", type: "system" },
              server_type: { name: "cax11", architecture: "arm" },
            },
          ],
        });
      if (
        u.hostname === "id.example.test" &&
        u.pathname === "/.well-known/openid-configuration"
      )
        return Response.json({
          issuer,
          jwks_uri: issuer + "/jwks",
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
        });
      assert.equal(u.hostname, "api.cloudflare.com");
      if (u.pathname.endsWith("/zones")) {
        const name = u.searchParams.get("name");
        return Response.json({
          success: true,
          result: [
            {
              name,
              status: "active",
              id: (name === "foundervillage.org" ? "b" : "c").repeat(32),
              account: {
                id:
                  conflictingZone && name === "founderhaus.org"
                    ? "d".repeat(32)
                    : cfAccount,
              },
            },
          ],
        });
      }
      if (u.pathname.endsWith("/access/apps"))
        return Response.json({
          success: true,
          result: (await exists(join(temp, "close-attempt")))
            ? [
                {
                  name: "fv-production-admin",
                  domain: "admin.foundervillage.org",
                  type: "self_hosted",
                  aud: "fixture-audience",
                },
              ]
            : [],
        });
      assert.equal(
        u.pathname,
        "/client/v4/accounts/" + cfAccount + "/access/organizations",
      );
      return Response.json({
        success: true,
        result: { auth_domain: "fixture.cloudflareaccess.com" },
      });
    },
  );
  t.mock.method(
    S3Client.prototype,
    "send",
    async (cmd: {
      constructor: { name: string };
      input: { Bucket: string };
    }) => {
      switch (cmd.constructor.name) {
        case "GetBucketAclCommand":
          return { Owner: { ID: cmd.input.Bucket + "-owner" } };
        case "GetBucketVersioningCommand":
          return { Status: "Enabled" };
        case "GetObjectLockConfigurationCommand":
          return {
            ObjectLockConfiguration: {
              ObjectLockEnabled: objectLock ? "Enabled" : "",
            },
          };
        default:
          throw new Error("unexpected S3 operation");
      }
    },
  );
  const prepareOnce = async () =>
    prepare(checkout, home, await mkdtemp(join(home, ".test-")), keys);
  const first = await prepareOnce(),
    generation = await readlink(join(home, "current"));
  assert.deepEqual(first.manifest.ssh_cidrs, ["192.0.2.20/32"]);
  assert.equal(first.manifest.cloudflare.account_id, cfAccount);
  assert.equal(
    first.manifest.auth.frontend_client_ids["founder-village-app"],
    "app-client",
  );
  assert(!JSON.stringify(first.runtime).includes(inputs.FV_PAGES_API_TOKEN));
  assert(
    !JSON.stringify(first.runtime).includes(inputs.CLOUDFLARE_PROVISION_TOKEN),
  );
  assert(!JSON.stringify(first.runtime).includes(inputs.FV_HCLOUD_TOKEN));
  assert.equal((await stat(first.file)).mode & 0o777, 0o600);
  await prepareOnce();
  assert.equal(await readlink(join(home, "current")), generation);
  conflictingZone = true;
  await assert.rejects(prepareOnce, /active apex zones/);
  conflictingZone = false;
  objectLock = false;
  await assert.rejects(prepareOnce, /immutable storage/);
  assert.equal(await readlink(join(home, "current")), generation);
  objectLock = true;
  await deploymentFixture(checkout, original, first);
  await assert.rejects(deploy(first), /lockdown/);
  assert.equal(await privateText(first.sealedFile), first.sealIntent);
  assert(!(await exists(join(home, "deployment.json"))));
  const closed = await prepareOnce();
  assert.deepEqual(closed.manifest.ssh_cidrs, []);
  assert.equal(closed.bootstrap.host, "ssh.foundervillage.org");
  await deploy(closed);
  const operations = () => readFile(join(temp, "trace"), "utf8");
  assert.deepEqual((await operations()).trim().split("\n"), [
    "cf apply",
    "provider open",
    "install direct",
    "cf verify",
    "public api",
    "tunnel ssh",
    "host close",
    "provider close",
    "cf apply",
    "install tunnel",
    "cf verify",
    "public api",
    "tunnel ssh",
    "host close",
    "provider close",
    "tunnel ssh",
    "public api",
    "pages provision",
    "pages deploy",
    "pages verify",
  ]);
  const before = await operations();
  await deploy(await prepareOnce());
  assert.equal(
    (await operations()).slice(before.length),
    "cf verify\ntunnel ssh\npublic api\npages verify\n",
  );
  await publish(join(creds, "FV_SSH_HOST_PUBLIC_KEY"), keys.operatorPublic);
  await assert.rejects(prepareOnce, /host key/);
  await chmod(join(creds, "FV_HCLOUD_TOKEN"), 0o644);
  await assert.rejects(prepareOnce, /unsafe owner/);
  await symlink(keys.operator, join(temp, "linked-key"));
  await assert.rejects(privateText(join(temp, "linked-key")));
});

test("Interrupted Access service-token issuance is recoverable without creating extra tokens", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "fv-machine-token-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const service = {
    name: "",
    id: randomUUID(),
    client_id: "fixture.access",
    enabled: true,
    expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
  };
  let created = false,
    creates = 0,
    rotations = 0;
  const api: CfRequest = async (url, method, body) => {
    if (!method || method === "GET") return created ? [service] : [];
    if (url.endsWith("/rotate")) {
      rotations++;
      return { ...service, client_secret: "s".repeat(48) };
    }
    service.name = (body as { name: string }).name;
    created = true;
    creates++;
    throw new Error("interrupted after creation");
  };
  const get = () =>
    machineAccess(dir, "a".repeat(32), 42, "fixture-public", api);
  await assert.rejects(get);
  const issued = await get();
  assert.deepEqual(await get(), issued);
  assert.equal(creates, 1);
  assert.equal(rotations, 1);
  service.enabled = false;
  await assert.rejects(get, /drift/);
  const other = join(dir, "other");
  await mkdir(other, { mode: 0o700 });
  await assert.rejects(
    machineAccess(other, "a".repeat(32), 42, "fixture-public", api),
    /Conflicting/,
  );
  assert.equal(await exists(join(other, "identity")), false);
  assert.throws(
    () =>
      checkGrantPlan({
        resource_changes: [{ change: { actions: ["delete", "create"] } }],
      }),
    /replace/,
  );
});
