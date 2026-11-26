import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { z } from "zod";
import { issueGrants } from "./authority.ts";
import { cloudflareGrantNames } from "./bindings.ts";
import { accountPin, apexZones, launcherHash } from "./discovery.ts";
import {
  BootstrapError,
  credential,
  credentialDirectory,
  exists,
  privateDirectory,
  privateText,
  publish,
  run,
  stage,
} from "./workstation.ts";

const id = z.string().regex(/^[a-f0-9]{32}$/);
const permission = z.object({
  id,
  name: z.string(),
  scopes: z.array(z.string()),
  is_selectable: z.boolean(),
});
const policy = z.object({
  target: z.enum(["runtimeZone", "bothZones", "account"]),
  groups: z.array(z.string()).min(1),
});
const names = z.enum(cloudflareGrantNames);

export async function issueCloudflareGrants(home: string) {
  const root = process.cwd();
  const account = await accountPin(root);
  if (!account)
    throw new BootstrapError(
      "Cloudflare issuance requires the private Founder account pin.",
    );
  const profile = "founder-village-release";
  await launcherHash(root);
  const cf = (args: string[]) =>
    run(join(root, "node_modules/cf/bin/cf"), [...args, "--profile", profile], {
      CLOUDFLARE_ACCOUNT_ID: account,
      CF_SEND_TELEMETRY: "false",
      WRANGLER_LOG_SANITIZE: "true",
    });
  const rules = z
    .record(names, z.array(policy).min(1))
    .parse(
      JSON.parse(
        await readFile(
          join(root, "infra/production-authority/grants.json"),
          "utf8",
        ),
      ),
    );
  const authority = join(home, "cloudflare-authority");
  const directory = credentialDirectory();
  if (!isAbsolute(directory))
    throw new BootstrapError(
      "The protected runner mount must use an absolute path.",
    );
  await privateDirectory(directory);
  const actual = await realpath(directory);
  const checkout = await realpath(root);
  if (actual === checkout || actual.startsWith(checkout + sep))
    throw new BootstrapError(
      "Keep the protected runner mount outside the checkout.",
    );
  const issuer = await credential("FV_CF_TOKEN_ISSUER");
  if (issuer) {
    const work = await mkdtemp(join(home, ".issue-cloudflare-"));
    try {
      const issued = await stage(
        "Delegated Cloudflare grant issuance failed.",
        () => issueGrants(root, home, work, true, issuer),
      );
      for (const name of names.options) {
        const file = join(directory, name);
        if (
          (await exists(file)) &&
          (await privateText(file)).trim() === issued[name]
        )
          continue;
        await publish(file, issued[name] + "\n");
      }
      return { available: new Map(Object.entries(issued)), unavailable: [] };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  if (await exists(join(authority, "production.tfstate")))
    throw new BootstrapError(
      "Supply the delegated issuer for the existing Terraform-managed Cloudflare grants.",
    );
  const zoneIds = new Map<string, string>();
  for (const name of apexZones) {
    const zone = await stage(
      "Cloudflare could not verify both active Founder zones in the pinned account.",
      async () => {
        const [owned] = z
          .tuple([
            z.object({
              id,
              name: z.literal(name),
              status: z.literal("active"),
              account: z.object({ id: z.literal(account) }),
            }),
          ])
          .parse(
            JSON.parse(
              await cf([
                "zones",
                "list",
                "--account-id",
                account,
                "--name",
                name,
                "--status",
                "active",
              ]),
            ),
          );
        return owned.id;
      },
    );
    zoneIds.set(name, zone);
  }
  const groups = await stage(
    "The Founder CLI profile cannot list selectable account token permissions.",
    async () =>
      z
        .array(permission)
        .parse(
          JSON.parse(
            await cf(["accounts", "tokens", "permission-groups", "list"]),
          ),
        )
        .filter((g) => g.is_selectable),
  );
  const tokenNames = new Set<string>();
  for (let page = 1; ; page++) {
    const rows = await stage(
      "Cloudflare could not verify existing account token names.",
      async () =>
        z
          .array(z.object({ name: z.string() }))
          .parse(
            JSON.parse(
              await cf([
                "accounts",
                "tokens",
                "list",
                "--page",
                String(page),
                "--per-page",
                "50",
              ]),
            ),
          ),
    );
    rows.forEach((r) => tokenNames.add(r.name));
    if (rows.length < 50) break;
  }
  const available = new Map<string, string>();
  const unavailable: string[] = [];
  await privateDirectory(authority);
  for (const name of names.options) {
    const saved = await credential(name);
    if (saved) {
      available.set(name, saved);
      continue;
    }
    const tokenName =
      "founder-village-production-" + name.toLowerCase().replaceAll("_", "-");
    const intent = join(authority, name + ".issuing");
    if (tokenNames.has(tokenName) || (await exists(intent))) {
      throw new BootstrapError(
        "Reconcile the preceding issuance of " +
          name +
          " before creating another token.",
      );
    }
    const policies = rules[name].map(({ target, groups: required }) => {
      const scope =
        target === "account"
          ? "com.cloudflare.api.account"
          : "com.cloudflare.api.account.zone";
      const targets =
        target === "account"
          ? [account]
          : target === "bothZones"
            ? [...zoneIds.values()]
            : [id.parse(zoneIds.get("foundervillage.org"))];
      const selected = required.map((label) =>
        groups.filter((g) => g.name === label && g.scopes.includes(scope)),
      );
      if (selected.some((matches) => matches.length !== 1)) return undefined;
      return {
        effect: "allow",
        resources: Object.fromEntries(
          targets.map((key) => [scope + "." + key, "*"]),
        ),
        permission_groups: selected.map(([match]) => ({ id: match!.id })),
      };
    });
    if (policies.includes(undefined)) {
      unavailable.push(name);
      continue;
    }
    const create = [
      "accounts",
      "tokens",
      "create",
      "--name",
      tokenName,
      "--policies",
      JSON.stringify(policies),
    ];
    // The generated account-token API commands resolve the account from the
    // environment. Check the resolved mutation URL before issuing a credential.
    await stage(
      "The Cloudflare CLI did not resolve the pinned account for issuance.",
      async () => {
        z.object({
          method: z.literal("POST"),
          url: z.literal(
            "https://api.cloudflare.com/client/v4/accounts/" +
              account +
              "/tokens",
          ),
        }).parse(JSON.parse(await cf([...create, "--dry-run"])));
      },
    );
    // A lost creation response cannot safely be replayed. Keep the private intent
    // until the returned one-time value has reached its recoverable projection.
    await mkdir(intent, { mode: 0o700 });
    const value = await stage(
      "Account token creation has an uncertain outcome for " +
        name +
        ". Reconcile its provider entry before retrying.",
      async () => {
        const created = z
          .object({
            id,
            name: z.literal(tokenName),
            value: z.string().regex(/^[!-~]+$/),
          })
          .parse(JSON.parse(await cf(create)));
        return created.value;
      },
    );
    await publish(join(directory, name), value + "\n");
    await rmdir(intent);
    available.set(name, value);
  }
  return { available, unavailable };
}
