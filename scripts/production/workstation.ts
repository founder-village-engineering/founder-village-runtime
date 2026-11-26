import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
export const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export class BootstrapError extends Error {}

// Only static stage names and missing credential names may appear in public logs.
export async function stage<T>(
  description: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError(description);
  }
}
export const baseEnv = () => ({
  PATH: process.env.PATH,
  HOME: homedir(),
  LANG: "C",
  CI: "true",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS_REQUIRE: "never",
});
export async function run(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input?: string,
  timeout = 120_000,
) {
  const child = exec(program, args, {
    env: { ...baseEnv(), ...env },
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  child.child.stdin?.on("error", () => {});
  child.child.stdin?.end(input);
  return (await child).stdout.trim();
}
// Builds and dependency installs can emit long logs. These operations only
// need an exit status and must not copy private output into the runner log.
export function runQuiet(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, {
      env: { ...baseEnv(), ...env },
      stdio: "ignore",
      timeout,
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Child process failed")),
    );
  });
}
export async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export async function privateText(
  file: string,
  mounted = false,
): Promise<string> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = await handle.stat();
    if (
      !st.isFile() ||
      st.size > 256 * 1024 ||
      st.mode & 0o077 ||
      (st.uid !== process.getuid!() && !(mounted && st.uid === 0))
    )
      throw new BootstrapError(
        "A private input has an unsafe owner, mode, type or size.",
      );
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
export async function privateDirectory(dir: string) {
  await mkdir(dir, { mode: 0o700, recursive: true });
  const st = await lstat(dir);
  if (!st.isDirectory() || st.uid !== process.getuid!() || st.mode & 0o077)
    throw new BootstrapError(
      "Bootstrap state requires an owner-only directory.",
    );
}
export async function workstationDirectory(root: string) {
  const dir =
    process.env.FV_PRODUCTION_HOME ??
    join(homedir(), ".local/share/founder-village/production");
  if (!isAbsolute(dir))
    throw new BootstrapError("FV_PRODUCTION_HOME must be absolute.");
  // Validate the existing path components before creating a directory or keys.
  let ancestor = resolve(dir);
  while (!(await exists(ancestor))) ancestor = resolve(ancestor, "..");
  const actual = resolve(
    await realpath(ancestor),
    relative(ancestor, resolve(dir)),
  );
  const repo = await realpath(root);
  if (actual === repo || actual.startsWith(repo + sep))
    throw new BootstrapError(
      "Keep the permanent workstation identities outside the checkout.",
    );
  await privateDirectory(dir);
  return realpath(dir);
}

export async function publish(file: string, contents: string, replace = false) {
  if (await exists(file)) {
    if ((await privateText(file)) === contents) return;
    if (!replace)
      throw new BootstrapError(
        "A pinned bootstrap input differs from its stored binding.",
      );
  }
  const temp = file + "." + randomUUID() + ".next";
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (replace) await rename(temp, file);
    else {
      try {
        await link(temp, file);
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code !== "EEXIST" ||
          (await privateText(file)) !== contents
        )
          throw e;
      }
    }
  } finally {
    await rm(temp, { force: true });
  }
}

export function credentialDirectory() {
  return (
    process.env.CREDENTIALS_DIRECTORY ??
    join(homedir(), ".config/founder-village/production/credentials")
  );
}

export async function projectedCredential(
  name: string,
): Promise<string | undefined> {
  const explicit = process.env[name + "_FILE"];
  const file = explicit ?? join(credentialDirectory(), name);
  if (explicit || (await exists(file)))
    return (await privateText(file, true)).trim() || undefined;
  return process.env[name]?.trim() || undefined;
}

let vaultwardenBindings: ReadonlyMap<string, string> = new Map();
export function useVaultwardenBindings(bindings: ReadonlyMap<string, string>) {
  vaultwardenBindings = bindings;
}

export async function credential(name: string): Promise<string | undefined> {
  const projected = await projectedCredential(name);
  const stored = vaultwardenBindings.get(name);
  if (projected && stored && projected !== stored)
    throw new BootstrapError(
      "The Vaultwarden binding conflicts with " + name + ".",
    );
  return stored ?? projected;
}

const publicKey = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]+)?$/;
export function ed25519(value: string) {
  const match = publicKey.exec(value.trim());
  const bytes = Buffer.from(match?.[1] ?? "", "base64");
  // OpenSSH's wire representation is the algorithm name followed by 32 key bytes.
  if (
    !match ||
    bytes.length !== 51 ||
    bytes.readUInt32BE(0) !== 11 ||
    bytes.toString("ascii", 4, 15) !== "ssh-ed25519" ||
    bytes.readUInt32BE(15) !== 32 ||
    bytes.toString("base64") !== match[1]
  )
    throw new BootstrapError("Expected an Ed25519 public key.");
  return "ssh-ed25519 " + match[1];
}
export async function identities(home: string) {
  const dir = join(home, "identity");
  const operator = join(dir, "operator"),
    signer = join(dir, "release"),
    signers = join(dir, "allowed_signers");
  if (!(await exists(dir))) {
    const temp = await mkdtemp(join(home, ".identity-"));
    try {
      for (const [name, input] of [
        ["operator", "FV_OPERATOR_SSH_KEY"],
        ["release", "FV_RELEASE_SIGNING_KEY"],
      ] as const) {
        const key = join(temp, name),
          supplied = await credential(input);
        if (supplied) await publish(key, supplied + "\n");
        else
          await run("ssh-keygen", [
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-C",
            "fv-production-" + name,
            "-f",
            key,
          ]);
        const pub = ed25519(
          await run("ssh-keygen", ["-y", "-P", "", "-f", key]),
        );
        await writeFile(key + ".pub", pub + "\n", { mode: 0o600 });
        if (name === "release")
          await publish(join(temp, "allowed_signers"), signerLine(pub));
      }
      const escrow = await credential("AGE_RECIPIENT");
      if (!escrow)
        await run("age-keygen", ["-o", join(temp, "recovery.agekey")]);
      const recipient =
        escrow ??
        (await run("age-keygen", ["-y", join(temp, "recovery.agekey")]));
      await publish(
        join(temp, "recipient"),
        z
          .string()
          .regex(/^age1[a-z0-9]{40,}$/)
          .parse(recipient) + "\n",
      );
      for (const name of ["TEAM_CONTENT_KEY", "AUDIT_HMAC_KEY"]) {
        const value =
          (await credential(name)) ?? randomBytes(32).toString("hex");
        if (
          name === "TEAM_CONTENT_KEY"
            ? !/^[0-9a-f]{64}$/i.test(value)
            : !/^[!-~]{32,512}$/.test(value)
        )
          throw new BootstrapError("Invalid persistent application key.");
        await publish(join(temp, name), value + "\n");
      }
      await rename(temp, dir);
    } finally {
      await rm(temp, { force: true, recursive: true });
    }
  }
  await privateDirectory(dir);
  const pubs: string[] = [];
  for (const [key, varName] of [
    [operator, "FV_OPERATOR_SSH_KEY"],
    [signer, "FV_RELEASE_SIGNING_KEY"],
  ] as const) {
    const pem = await privateText(key);
    const supplied = await credential(varName);
    if (supplied && supplied !== pem.trim())
      throw new BootstrapError(
        "The mounted identity differs from the enrolled workstation.",
      );
    const pub = ed25519(await run("ssh-keygen", ["-y", "-P", "", "-f", key]));
    if (ed25519(await readFile(key + ".pub", "utf8")) !== pub)
      throw new BootstrapError("Workstation public key mismatch.");
    pubs.push(pub);
  }
  const [op, release] = pubs;
  if (op === release || (await privateText(signers)) !== signerLine(release!))
    throw new BootstrapError("Workstation signing trust mismatch.");
  const recipient = (await privateText(join(dir, "recipient"))).trim();
  if (
    (await exists(join(dir, "recovery.agekey"))) &&
    (await run("age-keygen", ["-y", join(dir, "recovery.agekey")])) !==
      recipient
  )
    throw new BootstrapError("Recovery identity mismatch.");
  const catalog: Record<string, string> = { AGE_RECIPIENT: recipient };
  for (const key of ["TEAM_CONTENT_KEY", "AUDIT_HMAC_KEY"])
    catalog[key] = (await privateText(join(dir, key))).trim();
  for (const [name, value] of Object.entries(catalog)) {
    const projected = await credential(name);
    if (projected && projected !== value)
      throw new BootstrapError(
        "An enrolled recovery or application key changed.",
      );
  }
  return { operator, signer, signers, operatorPublic: op!, catalog };
}
const signerLine = (pub: string) =>
  'founder-village-release namespaces="fv-release-v3" ' + pub + "\n";
