import { argon2Sync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { browserToken } from "./browser-token.ts";
import { distributedBindings } from "./bindings.ts";
import { accountPin, credentialPreflight } from "./discovery.ts";
import {
  acquireWorkstationLock,
  BootstrapError,
  credentialDirectory,
  exists,
  json,
  privateDirectory,
  privateText,
  projectedCredential,
  publish,
  run,
  stage,
  workstationDirectory,
  useVaultwardenBindings,
} from "./workstation.ts";

const productionVault = "https://vault.foundervillage.org";
const workstationVault = "https://vault.fv";
const itemTitle = "Founder Village production bindings";
const allowed = new Set<string>(distributedBindings);
const connection = {
  server: z.enum([productionVault, workstationVault]),
  profile: z.string().refine(isAbsolute),
  caFile: z.string().refine(isAbsolute).optional(),
  cli: z.string().refine(isAbsolute).optional(),
  unlockFile: z.string().refine(isAbsolute).optional(),
};
const binding = z.union([
  z
    .object({ ...connection, organizationId: z.uuid(), collectionId: z.uuid() })
    .strict(),
  z.object({ ...connection, ownerId: z.uuid() }).strict(),
]);
const vaultItem = z
  .object({
    id: z.uuid(),
    name: z.literal(itemTitle),
    type: z.literal(2),
    organizationId: z.uuid().nullish(),
    collectionIds: z.array(z.uuid()).nullish(),
    fields: z
      .array(
        z.object({
          type: z.literal(1),
          name: z.string(),
          value: z.string(),
        }),
      )
      .nullish(),
  })
  .passthrough();

export async function openProductionVault(required = false) {
  const explicit = process.env.FV_VAULTWARDEN_BINDING_FILE;
  const path =
    explicit ??
    join(
      homedir(),
      ".config/founder-village/production/vaultwarden/binding.json",
    );
  if (!required && !explicit && !(await exists(path))) return undefined;
  const selected = await stage(
    "Vaultwarden requires a valid owner-only binding file.",
    async () => binding.parse(JSON.parse(await privateText(path))),
  );
  const session = process.env.BW_SESSION_FILE
    ? (await privateText(process.env.BW_SESSION_FILE, true)).trim()
    : process.env.BW_SESSION?.trim();
  if (session && /\s/.test(session))
    throw new BootstrapError("Invalid Founder Village Vaultwarden session.");
  await privateDirectory(selected.profile);
  const env = {
    BITWARDENCLI_APPDATA_DIR: selected.profile,
    BW_SESSION: session,
    NODE_EXTRA_CA_CERTS: selected.caFile,
  };
  const bw = (args: string[], input?: string) =>
    stage("Founder Village Vaultwarden CLI operation failed.", () =>
      run(
        selected.cli ?? "bw",
        [...args, "--nointeraction", "--raw"],
        env,
        input,
        35_000,
      ),
    );
  const readJson = async <T>(
    args: string[],
    schema: z.ZodType<T>,
    input?: string,
  ) =>
    await stage("Unexpected Founder Village Vaultwarden response.", async () =>
      schema.parse(JSON.parse(await bw(args, input))),
    );
  const readStatus = () =>
    readJson(
      ["status"],
      z.object({
        serverUrl: z.string().nullable(),
        status: z.string(),
        userId: z.uuid().nullable(),
      }),
    );
  let status = await readStatus();
  if (status.serverUrl?.replace(/\/$/, "") !== selected.server)
    throw new BootstrapError(
      "The Bitwarden CLI profile points to a different server.",
    );
  if (!session && status.status === "locked" && selected.unlockFile) {
    await privateText(selected.unlockFile, true);
    env.BW_SESSION = await bw([
      "unlock",
      "--passwordfile",
      selected.unlockFile,
    ]);
    status = await readStatus();
  }
  if (status.status !== "unlocked")
    throw new BootstrapError(
      "The Bitwarden profile must be unlocked on the bound Founder Village Vaultwarden server.",
    );
  if ("ownerId" in selected && status.userId !== selected.ownerId)
    throw new BootstrapError(
      "The Bitwarden CLI profile belongs to a different account.",
    );
  const organizationId =
    "organizationId" in selected ? selected.organizationId : null;
  const collectionId =
    "collectionId" in selected ? selected.collectionId : null;
  const scope = [
    "--organizationid",
    organizationId ?? "null",
    "--collectionid",
    collectionId ?? "null",
  ];

  async function read() {
    await bw(["sync"]);
    const entries = await readJson(
      ["list", "items", ...scope, "--search", itemTitle],
      z.array(z.object({ name: z.string(), id: z.uuid() })),
    );
    const matches = entries.filter(({ name }) => name === itemTitle);
    if (matches.length > 1)
      throw new BootstrapError(
        "The Vaultwarden collection contains duplicate production binding items.",
      );
    const record =
      matches[0] && (await readJson(["get", "item", matches[0].id], vaultItem));
    const values = new Map<string, string>();
    if (record) {
      const collections = record.collectionIds ?? [];
      if (
        (record.organizationId ?? null) !== organizationId ||
        collections.length !== (collectionId ? 1 : 0) ||
        (collectionId && collections[0] !== collectionId) ||
        record.deletedDate
      )
        throw new BootstrapError(
          "The Vaultwarden binding item is outside the selected collection.",
        );
      for (const field of record.fields ?? []) {
        if (
          values.has(field.name) ||
          !allowed.has(field.name) ||
          !validValue(field.value)
        )
          throw new BootstrapError(
            "The Vaultwarden binding item contains an invalid or duplicate field.",
          );
        values.set(field.name, field.value);
      }
    }
    return { record, values };
  }

  async function mergeFields(incoming: ReadonlyMap<string, string>) {
    const { record, values } = await read();
    let added = 0;
    for (const [name, value] of incoming) {
      if (!allowed.has(name) || !validValue(value))
        throw new BootstrapError(
          "A projected production credential has an invalid format.",
        );
      const saved = values.get(name);
      if (saved !== undefined && saved !== value)
        throw new BootstrapError(
          "The stored Vaultwarden value differs for " + name + ".",
        );
      if (saved === undefined) {
        values.set(name, value);
        added++;
      }
    }
    if (added) {
      const draft = {
        ...record,
        name: itemTitle,
        type: 2,
        secureNote: { type: 0 },
        organizationId,
        collectionIds: collectionId ? [collectionId] : [],
        fields: [...values].map(([name, value]) => ({ type: 1, name, value })),
      };
      const args = record ? ["edit", "item", record.id] : ["create", "item"];
      // The CLI reads base64 from stdin. It must never appear in argv or logs.
      await bw(args, Buffer.from(JSON.stringify(draft)).toString("base64"));
    }
    const verified = (await read()).values;
    if ([...values].some(([name, value]) => verified.get(name) !== value))
      throw new BootstrapError(
        "Vaultwarden production binding read-back failed.",
      );
    return { added, values: verified };
  }

  async function merge(incoming: ReadonlyMap<string, string>) {
    // Each provider enrolls fields on the same note. Serialize the complete
    // read/edit/read-back sequence for commands using this workstation profile.
    const db = await acquireWorkstationLock(
      join(selected.profile, "production-bindings.lock"),
      "Another enrollment is updating the Vaultwarden item.",
    );
    try {
      return await mergeFields(incoming);
    } finally {
      db.close();
    }
  }
  return { read, merge };
}

function validValue(value: string) {
  return value.trim() === value && value.length > 0 && !/[\r\n\0]/.test(value);
}

function localRuntime(args: string[], home: string, input?: string) {
  return run(
    "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "-p",
      "fv-cli",
      "--",
      "--config",
      "config/local.json",
      ...args,
    ],
    { FV_PRODUCTION_HOME: home },
    input,
    300_000,
  );
}

async function workstationBindings() {
  const values = new Map<string, string>();
  for (const name of distributedBindings) {
    const value = await projectedCredential(name);
    if (value !== undefined) values.set(name, value);
  }
  const home =
    process.env.FV_PRODUCTION_HOME ??
    join(homedir(), ".local/share/founder-village/production");
  const identity = join(home, "identity");
  for (const [name, filename] of [
    ["AGE_RECIPIENT", "recipient"],
    ["TEAM_CONTENT_KEY", "TEAM_CONTENT_KEY"],
    ["AUDIT_HMAC_KEY", "AUDIT_HMAC_KEY"],
  ] as const) {
    const path = join(identity, filename);
    if (await exists(path)) {
      const enrolled = (await privateText(path)).trim();
      if (values.has(name) && values.get(name) !== enrolled)
        throw new BootstrapError(
          "The projected value differs from the enrolled " + name + ".",
        );
      values.set(name, enrolled);
    }
  }
  const candidate = join(process.cwd(), "config/candidate.private.json");
  if (!values.has("FV_HETZNER_CANDIDATE") && (await exists(candidate)))
    values.set(
      "FV_HETZNER_CANDIDATE",
      JSON.stringify(JSON.parse(await privateText(candidate))),
    );
  const account = await accountPin(process.cwd());
  if (account) values.set("FV_CLOUDFLARE_ACCOUNT_ID", account);
  return values;
}

async function startWorkstationVault() {
  const root = process.cwd();
  const home = await workstationDirectory(root);
  const dir = join(home, "bootstrap-vault");
  if (!(await exists(dir))) {
    const work = await mkdtemp(join(home, ".bootstrap-vault-"));
    try {
      const passphrase = randomBytes(32).toString("base64url");
      const nonce = randomBytes(16);
      const hash = argon2Sync("argon2id", {
        message: passphrase,
        nonce,
        memory: 65540,
        parallelism: 4,
        passes: 3,
        tagLength: 32,
      });
      const base64 = (bytes: Buffer) =>
        bytes.toString("base64").replace(/=+$/, "");
      const encoded =
        "$argon2id$v=19$m=65540,t=3,p=4$" + base64(nonce) + "$" + base64(hash);
      await publish(join(work, "admin-passphrase"), passphrase + "\n");
      await publish(join(work, "config.json"), json({ admin_token: encoded }));
      await rename(work, dir);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  await privateDirectory(dir);
  const edge = join(root, ".state/local/edge");
  await mkdir(edge, { recursive: true, mode: 0o700 });
  await publish(join(edge, "vault-home"), home + "\n");
  await stage("Could not start the local Vaultwarden service.", () =>
    localRuntime(["local-edge", "up"], home),
  );
  await stage("The workstation Vaultwarden HTTPS probe failed.", () =>
    run("curl", [
      "-q",
      "--fail",
      "--silent",
      "--max-time",
      "10",
      "--cacert",
      ".state/local/edge/root.crt",
      "--resolve",
      "vault.fv:443:[::1]",
      "--noproxy",
      "*",
      workstationVault + "/alive",
    ]),
  );
  console.log(
    "Founder Village workstation Vaultwarden is ready at " +
      workstationVault +
      ".",
  );
}

async function inviteWorkstationUser() {
  const home = await workstationDirectory(process.cwd());
  const passphrase = (
    await privateText(join(home, "bootstrap-vault/admin-passphrase"))
  ).trim();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const email = await input[Symbol.asyncIterator]().next();
  input.close();
  if (email.done || !z.email().safeParse(email.value).success)
    throw new BootstrapError("Supply the invite address on stdin.");
  await stage("The workstation Vaultwarden invitation failed.", () =>
    localRuntime(
      ["vaultwarden-invite"],
      home,
      email.value + "\n" + passphrase + "\n",
    ),
  );
  console.log("Founder Village workstation Vaultwarden invitation created.");
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  const browser =
    command === "issue-cloudflare" &&
    extra.length === 1 &&
    extra[0] === "--browser";
  if (
    (extra.length && !browser) ||
    ![
      "workstation",
      "workstation-invite",
      "issue-cloudflare",
      "import",
      "project",
      "status",
    ].includes(command ?? "")
  )
    throw new BootstrapError(
      "Usage: npm run production:vault -- workstation|workstation-invite|issue-cloudflare [--browser]|import|project|status",
    );
  if (command === "workstation") return startWorkstationVault();
  if (command === "workstation-invite") return inviteWorkstationUser();
  const vault = (await openProductionVault(true))!;
  if (command === "issue-cloudflare") {
    process.umask(0o077);
    const home = await workstationDirectory(process.cwd());
    const lock = await acquireWorkstationLock(
      join(home, "bootstrap.lock"),
      "Another production operation holds the workstation lock.",
    );
    try {
      useVaultwardenBindings((await vault.read()).values);
      const { issueCloudflareGrants } = await import("./cloudflare-grants.ts");
      const { available, unavailable } = await issueCloudflareGrants(
        home,
        browser ? () => browserToken("cloudflare") : undefined,
      );
      await vault.merge(available);
      process.stdout.write(
        json({ verifiedInVault: [...available.keys()], unavailable }),
      );
      process.exitCode = unavailable.length ? 1 : 0;
    } finally {
      lock.close();
    }
    return;
  }
  const result =
    command === "import"
      ? await vault.merge(await workstationBindings())
      : await vault.read();
  const values = result.values;
  if (command === "project") {
    const directory = credentialDirectory();
    if (!isAbsolute(directory))
      throw new BootstrapError(
        "The credential directory must be an absolute path.",
      );
    await privateDirectory(directory);
    const pending = new Map<string, string>();
    for (const [name, value] of values) {
      const file = join(directory, name);
      if (await exists(file)) {
        if ((await privateText(file)).trim() !== value)
          throw new BootstrapError(
            "The projected file differs for " + name + ".",
          );
      } else {
        pending.set(file, value);
      }
    }
    for (const [file, value] of pending) await publish(file, value + "\n");
  }
  const report = await credentialPreflight(async (name) => values.get(name));
  process.stdout.write(
    json({
      stored: values.size,
      storedNames: [...values.keys()].sort(),
      ...(command === "import" && "added" in result
        ? { added: result.added }
        : {}),
      ...report,
    }),
  );
  if (command === "status" && !report.credentialProjectionComplete)
    process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await main().catch((error) => {
    console.error(
      error instanceof BootstrapError
        ? error.message
        : "Founder Village Vaultwarden operation failed.",
    );
    process.exitCode = 1;
  });
