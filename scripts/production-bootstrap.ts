import {
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { z } from "zod";
import {
  accountPin,
  bootstrapCidr,
  cloudApi,
  cloudBinding,
  credentialPreflight,
  launcherHash,
  loadInputs,
  oidcSettings,
  providerBinding,
  storageBinding,
} from "./production/discovery.ts";
import {
  BootstrapError,
  credential,
  digest,
  exists,
  identities,
  json,
  privateDirectory,
  privateText,
  publish,
  run,
  stage,
  workstationDirectory,
} from "./production/workstation.ts";
import { deploy } from "./production/deploy.ts";
import { issueGrants } from "./production/authority.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
export async function prepare(
  rootDir: string,
  home: string,
  work: string,
  keys: Awaited<ReturnType<typeof identities>>,
  apply = false,
) {
  const template = JSON.parse(
    await readFile(join(rootDir, "config/production.example.json"), "utf8"),
  ) as {
    environment: "production";
    project: string;
    api_domain: string;
    admin_domain: string;
    ssh_cidrs: string[];
    cloudflare: {
      zone_name: string;
      ssh_domain: string;
      managed_names: string[];
      cf_binary: string;
      access_aud: string;
    };
    backup: {
      retention_days: number;
      rpo_seconds: number;
      rto_seconds: number;
    };
  };
  const bearer = await credential("FV_HCLOUD_TOKEN");
  if (!bearer)
    throw new BootstrapError(
      "The runner has no Founder Village Hetzner project grant (FV_HCLOUD_TOKEN).",
    );
  const server = await stage(
    "Hetzner candidate identity or dedicated-project audit failed.",
    () => providerBinding(rootDir, work, home, template.project, bearer),
  );
  const issuer = await credential("FV_CF_TOKEN_ISSUER");
  if (
    issuer &&
    apply &&
    (await run("git", ["status", "--porcelain", "--untracked-files=normal"]))
  )
    throw new BootstrapError(
      "Grant issuance requires a clean runtime checkout.",
    );
  const issued = issuer
    ? await stage(
        "Delegated Founder Village Cloudflare grant issuance failed.",
        () =>
          issueGrants(
            rootDir,
            home,
            work,
            apply,
            issuer,
          ),
      )
    : {};
  const { values, host } = await loadInputs(issued);
  const [cloud, oidc, backup, sha] = await Promise.all([
    stage(
      "Cloudflare did not verify both active apex zones and the Access organization.",
      async () =>
        cloudBinding(
          template.cloudflare.zone_name,
          template.admin_domain,
          server.project,
          cloudApi(values.FV_PAGES_API_TOKEN!),
          cloudApi(values.CLOUDFLARE_PROVISION_TOKEN!),
          await accountPin(rootDir),
        ),
    ),
    stage("OIDC discovery or client policy validation failed.", () =>
      oidcSettings(values),
    ),
    stage("Independent immutable storage custody could not be verified.", () =>
      storageBinding(values),
    ),
    launcherHash(rootDir),
  ]);
  // Pin account custody across workstation checkouts as well as within the repo.
  await publish(
    join(home, "cloudflare-binding.json"),
    json({
      account_id: cloud.account_id,
      zone_id: cloud.zone_id,
      zone_name: template.cloudflare.zone_name,
    }),
  );
  const manifest = {
    ...template,
    project: server.project,
    provider: server.provider,
    auth: oidc,
    cloudflare: { ...template.cloudflare, ...cloud, cf_sha256: sha },
    backup: { ...template.backup, ...backup },
    ssh_cidrs: [] as string[],
  };
  const file = join(work, "production.private.json");
  await publish(file, json(manifest));
  const hc = { FV_HCLOUD_TOKEN: values.FV_HCLOUD_TOKEN };
  const status = await stage(
    "The production manifest or live firewall binding failed validation.",
    async () => {
      await run("bin/fv", ["--config", file, "validate"]);
      return z
        .object({
          project_isolated: z.literal(true),
          public_inbound_closed: z.boolean(),
          owned: z.boolean(),
        })
        .parse(
          JSON.parse(
            await run("bin/fv", ["--config", file, "provision", "status"], hc),
          ),
        );
    },
  );
  const sealedFile = join(home, "seal-intent.json");
  const sealIntent = json({
    account: cloud.account_id,
    server: server.provider.existing_server.id,
    ssh: manifest.cloudflare.ssh_domain,
  });
  const sealing = await exists(sealedFile);
  if (sealing && (await privateText(sealedFile)) !== sealIntent)
    throw new BootstrapError("Firewall lockdown belongs to another target.");
  const sealed = status.public_inbound_closed || sealing;
  if (!sealed)
    manifest.ssh_cidrs = [
      await stage(
        "Cannot resolve the workstation IPv4 allowlist.",
        bootstrapCidr,
      ),
    ];
  await publish(file, json(manifest), true);
  await run("bin/fv", ["--config", file, "validate"]);
  const revision = z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(await run("git", ["rev-parse", "HEAD"]));
  const releaseDir = join(
    home,
    "releases",
    revision + "-" + server.provider.architecture,
  );
  const ipv4 = server.provider.existing_server.ipv4,
    ssh = manifest.cloudflare.ssh_domain;
  await publish(
    join(work, "known_hosts"),
    [ipv4, ssh].map((h) => h + " " + server.key + "\n").join(""),
  );
  const rootIdentity = sealed
    ? undefined
    : await credential("FV_INITIAL_ROOT_SSH_KEY");
  // An existing server may trust a different first-login key. Only the
  // workstation uses that key, until the dedicated operator has been enrolled.
  const rootKey = rootIdentity ? join(work, "enroll-key") : undefined;
  if (rootKey) await publish(rootKey, rootIdentity + "\n");
  const runtime = { ...host, ...keys.catalog };
  const pages = {
    account_id: cloud.account_id,
    zone_name: template.cloudflare.zone_name,
  };
  const knownHosts = join(home, "current", "known_hosts");
  const bootstrap = {
    host: sealed ? ssh : ipv4,
    identityFile: keys.operator,
    knownHosts,
    ...(rootKey
      ? {
          initialRootPublicKey: keys.operator + ".pub",
          initialRootIdentityFile: join(home, "current", "enroll-key"),
        }
      : {}),
    config: join(home, "current", "production.private.json"),
    releaseDirectory: releaseDir,
    allowedSigners: keys.signers,
  };
  await publish(join(work, "bootstrap.private.json"), json(bootstrap));
  await publish(join(work, "pages-account.private.json"), json(pages));
  await publish(join(work, "host-catalog.json"), json(runtime));
  // Nothing is published for consumers until all inputs and live evidence pass.
  const generation =
    "generation-" +
    digest(
      json([manifest, bootstrap, server.key, runtime, rootIdentity ?? null]),
    );
  const dir = join(home, generation);
  if (!(await exists(dir))) await rename(work, dir);
  const current = join(home, "current");
  if (await exists(current)) {
    const prior = await readlink(current);
    if (!/^generation-[0-9a-f]{64}$/.test(prior))
      throw new BootstrapError("Unmanaged preparation pointer.");
  }
  const link = await mkdtemp(join(home, ".publish-"));
  try {
    await symlink(generation, join(link, "current"));
    await rename(join(link, "current"), current);
  } finally {
    await rm(link, { recursive: true, force: true });
  }
  return {
    home,
    values,
    manifest,
    file: bootstrap.config,
    keys,
    bootstrap,
    runtime,
    revision,
    releaseDir,
    pagesFile: join(current, "pages-account.private.json"),
    sealed,
    sealedFile,
    sealIntent,
  };
}

async function main() {
  const action = process.argv[2] ?? "prepare";
  if (
    process.argv.length > 3 ||
    !["preflight", "init", "prepare", "apply"].includes(action)
  )
    throw new BootstrapError(
      "Usage: npm run production:bootstrap -- preflight|init|prepare|apply",
    );
  if (action === "preflight") {
    const report = await credentialPreflight();
    process.stdout.write(json(report));
    process.exitCode = report.credentialProjectionComplete ? 0 : 1;
    return;
  }
  process.umask(0o077);
  process.chdir(root);
  const home = await workstationDirectory(root);
  const lock = join(home, "bootstrap.lock");
  if (!(await exists(lock))) await publish(lock, "");
  await privateText(lock);
  // The OS releases SQLite's advisory write lock if the workstation process dies.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(lock);
  try {
    await stage(
      "Another production bootstrap holds the workstation lock.",
      async () => db.exec("BEGIN IMMEDIATE"),
    );
    const keys = await stage("Workstation identity enrollment failed.", () =>
      identities(home),
    );
    console.log("Production workstation identities ready.");
    if (action === "init") return;
    await privateDirectory(join(home, "releases"));
    const prepareGeneration = async (issue: boolean) => {
      const work = await mkdtemp(join(home, ".prepare-"));
      try {
        return await prepare(root, home, work, keys, issue);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    };
    const prepared = await prepareGeneration(action === "apply");
    console.log(
      "Verified production inputs available in FV_PRODUCTION_HOME/current.",
    );
    // Rediscover the Access audience and sealed firewall before publishing their
    // final generation. Previously published configurations stay immutable.
    if (action === "apply" && (await deploy(prepared)))
      await prepareGeneration(false);
  } finally {
    db.close();
  }
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(
      error instanceof BootstrapError
        ? error.message
        : "Production bootstrap failed a private input or provider check.",
    );
    process.exitCode = 1;
  });
}
