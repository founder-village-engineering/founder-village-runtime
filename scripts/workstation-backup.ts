import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { machineAccess, savedMachineAccess } from "./production/access.ts";
import { cloudApi } from "./production/discovery.ts";
import { pinnedSshOptions } from "./production/ssh.ts";
import { openProductionVault } from "./production/vaultwarden.ts";
import {
  acquireWorkstationLock,
  baseEnv,
  BootstrapError,
  credential,
  digest,
  ed25519,
  exists,
  json,
  privateDirectory,
  privateText,
  publish,
  run,
  useVaultwardenBindings,
  workstationDirectory,
} from "./production/workstation.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const descriptorSchema = z
  .object({
    version: z.literal(1),
    backup: hash,
    sha256: hash,
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    signature: hash,
  })
  .strict();
type Descriptor = z.infer<typeof descriptorSchema>;
const archive = "snapshot.tar";
const marker = "verified.json";
const meta = "descriptor.json";
const transferTimeout = 7200_000;
// Node overflows longer timers to 1ms. Reserve both transfers and the
// deployer's ten-minute completion allowance in its outer process timeout.
const recoverySeconds = z
  .number()
  .int()
  .min(1)
  .max(Math.floor((2 ** 31 - 1 - 2 * transferTimeout - 600_000) / 1000));

export function transferDeadlineMs(
  action: "export" | "import-drill",
  rtoSeconds: number,
) {
  const restore = recoverySeconds.parse(rtoSeconds) * 1000;
  return action === "import-drill"
    ? transferTimeout + restore
    : transferTimeout;
}

export type WorkstationBackupConnection = {
  home: string;
  host: string;
  ipv4: string;
  sshDomain: string;
  knownHosts: string;
  identity: string;
  tunnelEnv?: NodeJS.ProcessEnv;
  retentionDays: number;
  rtoSeconds: number;
};

async function verifier(home: string) {
  const dir = join(home, "identity");
  const keyPath =
    process.env.FV_BACKUP_AGE_IDENTITY_FILE ?? join(dir, "recovery.agekey");
  await privateText(keyPath);
  const encrypted = await privateText(join(dir, "backup-verifier.age"));
  const expected = hash.parse(
    (await privateText(join(dir, "backup-verifier.sha256"))).trim(),
  );
  const key = hash.parse(
    await run("age", ["--decrypt", "--identity", keyPath], {}, encrypted),
  );
  if (digest(key) !== expected)
    throw new BootstrapError(
      "The decrypted backup verifier differs from its enrolled fingerprint.",
    );
  return key;
}

function mac(key: string, message: string) {
  return createHmac("sha256", key).update(message).digest("hex");
}
function matches(actual: string, expected: string) {
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  );
}
function statement(d: Descriptor) {
  return `fv-workstation-backup-v1\n${d.backup}\n${d.sha256}\n${d.size}\n`;
}
function authenticatedDescriptor(text: string, key: string) {
  const d = descriptorSchema.parse(JSON.parse(text));
  if (!matches(d.signature, mac(key, statement(d))))
    throw new BootstrapError("The backup descriptor signature is invalid.");
  return d;
}
function signReceipt(d: Descriptor, time: number, key: string) {
  return mac(
    key,
    `fv-workstation-restore-v1\n${d.backup}\n${d.sha256}\n${time}\n`,
  );
}
async function verifiedAt(dir: string, d: Descriptor, key: string) {
  const receipt = z
    .object({ verifiedAt: z.number().int().positive(), signature: hash })
    .strict()
    .parse(JSON.parse(await privateText(join(dir, marker))));
  if (!matches(receipt.signature, signReceipt(d, receipt.verifiedAt, key)))
    throw new BootstrapError("The stored isolated-restore receipt is invalid.");
  return receipt.verifiedAt;
}

async function storedArchive(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = await file.stat();
    if (
      !st.isFile() ||
      st.uid !== process.getuid!() ||
      st.mode & 0o077 ||
      st.nlink !== 1
    )
      throw new BootstrapError(
        "Backup archives require private, owner-controlled regular files.",
      );
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
async function verifyArchive(path: string, d: Descriptor) {
  const file = await storedArchive(path);
  try {
    if ((await file.stat()).size !== d.size) return false;
    const hasher = createHash("sha256");
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > d.size) return false;
      hasher.update(chunk);
    }
    return size === d.size && hasher.digest("hex") === d.sha256;
  } finally {
    await file.close();
  }
}

type Transfer = (
  action: "export" | "import-drill",
  stream: (child: ChildProcessWithoutNullStreams) => Promise<void>,
) => Promise<void>;
type Remote = {
  info: () => Promise<string>;
  verify: () => Promise<void>;
  transfer: Transfer;
};

async function connection(
  c: WorkstationBackupConnection,
  captureIfStale: boolean,
): Promise<Remote> {
  const options = await pinnedSshOptions(
    { host: c.host, knownHosts: c.knownHosts },
    c.ipv4,
    c.sshDomain,
  );
  const sshArgs = (action: string) => [
    ...options,
    "-i",
    c.identity,
    "-l",
    "fv",
    c.host,
    "cd /opt/founder-village && sudo -n bin/fv --config config/production.private.json backup " +
      action,
  ];
  const env =
    c.host === c.sshDomain
      ? {
          TUNNEL_SERVICE_TOKEN_ID: c.tunnelEnv?.TUNNEL_SERVICE_TOKEN_ID,
          TUNNEL_SERVICE_TOKEN_SECRET: c.tunnelEnv?.TUNNEL_SERVICE_TOKEN_SECRET,
        }
      : {};
  return {
    info: async () => {
      const describe = () =>
        run("ssh", sshArgs("export-info"), env, undefined, transferTimeout);
      try {
        return await describe();
      } catch (error) {
        // Only a host command failure calls for a new capture. SSH transport
        // failures (255), deadlines and signature failures propagate as failures.
        if (!captureIfStale || (error as { code?: unknown }).code !== 1)
          throw error;
        await run("ssh", sshArgs("capture"), env, undefined, transferTimeout);
        return describe();
      }
    },
    verify: async () => {
      await run("ssh", sshArgs("verify"), env, undefined, transferTimeout);
    },
    transfer: async (action, stream) => {
      const child = spawn("ssh", sshArgs(action), {
        env: { ...baseEnv(), ...env },
        stdio: "pipe",
        detached: true,
      });
      child.stdin.on("error", () => {});
      child.stderr.resume();
      const terminate = () => {
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* exited */
          }
      };
      const deadline = setTimeout(
        terminate,
        transferDeadlineMs(action, c.rtoSeconds),
      );
      const result = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? resolve()
            : reject(
                new BootstrapError("Remote backup " + action + " failed."),
              ),
        );
      });
      try {
        await Promise.all([result, stream(child)]);
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null && child.signalCode === null) terminate();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        await result.catch(() => {});
      }
    },
  };
}
async function download(path: string, d: Descriptor, transfer: Transfer) {
  let size = 0;
  await transfer("export", async (child) => {
    child.stdin.end();
    const limit = new Transform({
      transform(chunk, _, done) {
        size += chunk.length;
        if (size > d.size)
          done(new Error("Backup stream exceeds its signed size."));
        else done(null, chunk);
      },
    });
    await pipeline(
      child.stdout,
      limit,
      createWriteStream(path, { flags: "wx", mode: 0o600, flush: true }),
    );
  });
  if (size !== d.size || !(await verifyArchive(path, d)))
    throw new BootstrapError(
      "The downloaded backup failed its signed size or digest check.",
    );
}

async function requirePrivateDirectory(dir: string) {
  const st = await lstat(dir);
  if (!st.isDirectory() || st.uid !== process.getuid!() || st.mode & 0o077)
    throw new BootstrapError(
      "Backup storage requires an owner-only directory.",
    );
}
async function prune(root: string, keep: string, key: string, days: number) {
  const cutoff = Date.now() - days * 86400_000;
  for (const name of await readdir(root)) {
    if (name === keep || !hash.safeParse(name).success) continue;
    const dir = join(root, name);
    await requirePrivateDirectory(dir);
    if (!(await exists(join(dir, marker)))) continue;
    const d = authenticatedDescriptor(await privateText(join(dir, meta)), key);
    if (d.backup !== name)
      throw new BootstrapError("A stored backup has the wrong identifier.");
    if ((await verifiedAt(dir, d, key)) >= cutoff) continue;
    const files = (await readdir(dir)).sort();
    if (
      JSON.stringify(files) !==
        JSON.stringify([meta, archive, marker].sort()) ||
      !(await verifyArchive(join(dir, archive), d))
    )
      throw new BootstrapError(
        "An expired backup failed verification and was retained.",
      );
    // Remove a verified expired generation atomically from the active inventory.
    const retired = await mkdtemp(join(root, ".retired-"));
    try {
      await rename(dir, join(retired, name));
      await rm(retired, { recursive: true });
    } catch (error) {
      if (await exists(dir)) await rmdir(retired);
      throw error;
    }
  }
}

async function pull(
  root: string,
  key: string,
  days: number,
  remote: Remote,
  operator: string,
) {
  const d = authenticatedDescriptor(await remote.info(), key);
  const dir = join(root, d.backup);
  if (!(await exists(dir))) {
    const stage = await mkdtemp(join(root, ".incoming-"));
    try {
      await download(join(stage, archive), d, remote.transfer);
      await publish(join(stage, meta), json(d));
      await rename(stage, dir);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  } else {
    await requirePrivateDirectory(dir);
    const saved = authenticatedDescriptor(
      await privateText(join(dir, meta)),
      key,
    );
    if (saved.signature !== d.signature)
      throw new BootstrapError(
        "The existing backup differs from the host's signed descriptor.",
      );
    if (
      !(await exists(join(dir, archive))) ||
      !(await verifyArchive(join(dir, archive), d))
    ) {
      const repair = await mkdtemp(join(root, ".repair-"));
      try {
        await download(join(repair, archive), d, remote.transfer);
        await rename(join(repair, archive), join(dir, archive));
      } finally {
        await rm(repair, { recursive: true, force: true });
      }
    }
  }
  let needsDrill = true;
  if (await exists(join(dir, marker))) {
    await verifiedAt(dir, d, key);
    try {
      await remote.verify();
      needsDrill = false;
    } catch (error) {
      // Rebuild the host-side proof if the host lost its receipt.
      if ((error as { code?: unknown }).code !== 1) throw error;
    }
  }
  if (needsDrill) {
    const signature = Buffer.from(
      (await run(
        "ssh-keygen",
        [
          "-Y",
          "sign",
          "-f",
          operator,
          "-n",
          "fv-workstation-backup-receipt-v1",
        ],
        {},
        statement(d),
      )) + "\n",
      "ascii",
    );
    if (
      signature.length > 4096 ||
      !/^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+=/\n]+\n-----END SSH SIGNATURE-----\n$/.test(
        signature.toString("ascii"),
      )
    )
      throw new BootstrapError(
        "The workstation operator failed to sign the backup receipt.",
      );
    const frame = Buffer.alloc(4);
    frame.writeUInt32BE(signature.length);
    const file = await storedArchive(join(dir, archive));
    try {
      await remote.transfer("import-drill", async (child) => {
        child.stdout.resume();
        const body = async function* () {
          yield frame;
          yield signature;
          yield* file.createReadStream({ autoClose: true });
        };
        await pipeline(Readable.from(body()), child.stdin);
      });
    } finally {
      await file.close();
    }
    await remote.verify();
    const time = Date.now();
    await publish(
      join(dir, marker),
      json({ verifiedAt: time, signature: signReceipt(d, time, key) }),
      true,
    );
  }
  await prune(root, d.backup, key, days);
}

async function pullWorkstationBackup(
  c: WorkstationBackupConnection,
  captureIfStale: boolean,
) {
  const days = z.number().int().positive().parse(c.retentionDays);
  const root = join(repo, "backups");
  await privateDirectory(root);
  const lock = await acquireWorkstationLock(
    join(root, ".pull.lock"),
    "Another workstation backup operation is running.",
  );
  try {
    await pull(
      root,
      await verifier(c.home),
      days,
      await connection(c, captureIfStale),
      c.identity,
    );
  } finally {
    lock.close();
  }
}

async function scheduledConnection(
  home: string,
  deploymentRoute: boolean,
): Promise<WorkstationBackupConnection> {
  const current = await realpath(join(home, "current"));
  if (
    !current.startsWith(home + "/") ||
    !/^generation-[a-f0-9]{64}$/.test(current.slice(home.length + 1))
  )
    throw new BootstrapError(
      "The production generation is not bound to this workstation.",
    );
  await requirePrivateDirectory(current);
  const manifest = z
    .object({
      environment: z.literal("production"),
      provider: z.object({
        existing_server: z.object({
          id: z.number().int().positive(),
          ipv4: z.ipv4(),
        }),
      }),
      cloudflare: z.object({
        account_id: z.string().regex(/^[a-f0-9]{32}$/),
        ssh_domain: z.literal("ssh.foundervillage.org"),
      }),
      backup: z.object({
        mode: z.literal("workstation"),
        retention_days: z.number().int().min(30),
        rto_seconds: recoverySeconds,
      }),
    })
    .parse(
      JSON.parse(await privateText(join(current, "production.private.json"))),
    );
  const identity = join(home, "identity", "operator");
  await privateText(identity);
  const server = manifest.provider.existing_server;
  const sshDomain = manifest.cloudflare.ssh_domain;
  const bootstrap = z
    .object({
      host: z.union([z.literal(server.ipv4), z.literal(sshDomain)]),
      identityFile: z.literal(identity),
      knownHosts: z.literal(join(home, "current", "known_hosts")),
    })
    .parse(
      JSON.parse(await privateText(join(current, "bootstrap.private.json"))),
    );
  const host = deploymentRoute ? bootstrap.host : sshDomain;
  let tunnelEnv: NodeJS.ProcessEnv | undefined;
  if (host === sshDomain) {
    const pub = ed25519(await readFile(identity + ".pub", "utf8"));
    const account = manifest.cloudflare.account_id;
    const saved = await savedMachineAccess(home, account, server.id, pub);
    tunnelEnv = saved.env;
    // The deployer already reconciles this credential on the deployment route.
    // Periodic standalone jobs renew it near expiry using the same pinned policy.
    if (!deploymentRoute && saved.expiresAt < Date.now() + 7 * 86400_000) {
      const vault = await openProductionVault();
      if (vault) useVaultwardenBindings((await vault.read()).values);
      const provision = await credential("CLOUDFLARE_PROVISION_TOKEN");
      if (!provision)
        throw new BootstrapError(
          "Tunnel credential renewal requires the scoped Cloudflare provisioning credential.",
        );
      tunnelEnv = (
        await machineAccess(home, account, server.id, pub, cloudApi(provision))
      ).env;
    }
  }
  return {
    home,
    host,
    ipv4: server.ipv4,
    sshDomain,
    knownHosts: join(current, "known_hosts"),
    identity,
    tunnelEnv,
    retentionDays: manifest.backup.retention_days,
    rtoSeconds: manifest.backup.rto_seconds,
  };
}
async function verifySaved(home: string, selected?: string) {
  const key = await verifier(home),
    root = join(repo, "backups");
  await requirePrivateDirectory(root);
  const lock = await acquireWorkstationLock(
    join(root, ".pull.lock"),
    "Another workstation backup operation is running.",
  );
  try {
    const dirs = selected
      ? [hash.parse(selected)]
      : (await readdir(root)).filter((name) => hash.safeParse(name).success);
    if (!dirs.length)
      throw new BootstrapError("There are no workstation snapshots to verify.");
    for (const name of dirs) {
      const dir = join(root, name);
      await requirePrivateDirectory(dir);
      const d = authenticatedDescriptor(
        await privateText(join(dir, meta)),
        key,
      );
      if (d.backup !== name || !(await verifyArchive(join(dir, archive), d)))
        throw new BootstrapError("A workstation backup failed verification.");
      await verifiedAt(dir, d, key);
    }
    console.log(
      `Verified ${dirs.length} workstation backup(s) and recorded isolated-restore receipts.`,
    );
  } finally {
    lock.close();
  }
}
async function main() {
  process.umask(0o077);
  const [action, flag, ...extra] = process.argv.slice(2);
  const deploymentRoute = action === "pull" && flag === "--deployment-route";
  if (
    extra.length ||
    (flag &&
      !deploymentRoute &&
      !(action === "verify" && hash.safeParse(flag).success)) ||
    !["pull", "verify"].includes(action ?? "")
  )
    throw new BootstrapError(
      "Usage: workstation-backup.ts pull [--deployment-route] | verify [backup-id]",
    );
  const home = await workstationDirectory(repo);
  if (action === "verify") return verifySaved(home, flag);
  await pullWorkstationBackup(
    await scheduledConnection(home, deploymentRoute),
    !deploymentRoute,
  );
  console.log(
    "Verified workstation backup copy and host isolated-restore receipt.",
  );
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await main().catch((error) => {
    console.error(
      error instanceof BootstrapError
        ? error.message
        : "Workstation backup failed.",
    );
    process.exitCode = 1;
  });
