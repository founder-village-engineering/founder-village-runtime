import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pool, secret } from "../packages/database/index.ts";
import { encryptAuditSnapshot } from "./audit-snapshot.ts";
import {
  recoveryArtifact,
  auditSnapshot,
  recoveryVerifyTimeout,
} from "./recovery-artifact.ts";
const exec = promisify(execFile),
  env = secret("FV_ENV");
if (!["local", "staging", "production"].includes(env))
  throw new Error("invalid environment");
const id = process.argv[2];
if (!id || !/^[a-f0-9]{64}$/.test(id))
  throw new Error("backup fingerprint required");
const dir = path.resolve(`.state/${env}/recovery/${id}`);
await mkdir(dir, { recursive: true, mode: 0o700 });
if (!(await lstat(dir)).isDirectory())
  throw new Error("unsafe recovery directory");
try {
  await readFile(`${dir}/manifest.json`);
  await exec(
    process.execPath,
    import.meta.url.endsWith(".js")
      ? ["dist/scripts/verify-recovery.js", dir]
      : ["--import", "tsx", "scripts/verify-recovery.ts", dir],
    { timeout: recoveryVerifyTimeout },
  );
  console.log("existing recovery bundle verified");
  process.exit(0);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const recipient = secret("AGE_RECIPIENT");
if (!/^age1[a-z0-9]{40,}$/.test(recipient))
  throw new Error("independent recovery recipient required");
if (!(await lstat(`.state/${env}.env`)).isFile())
  throw new Error("unsafe runtime catalog");
const configFile = `.state/${env}/runtime.json`;
if (!(await lstat(configFile)).isFile())
  throw new Error("unsafe runtime manifest");
const runtime = JSON.parse(await readFile(configFile, "utf8")) as {
  cloudflare?: { ssh_domain?: string };
  backup?: { mode?: string };
};
if (runtime.backup?.mode === "workstation") {
  const db = pool("RUNNER_DATABASE_URL");
  try {
    await encryptAuditSnapshot(
      db,
      id,
      recipient,
      path.join(dir, auditSnapshot),
    );
  } finally {
    await db.end();
  }
}
await exec(
  "age",
  ["-r", recipient, "-o", `${dir}/runtime.env.age`, `.state/${env}.env`],
  { timeout: 30000 },
);
const inputs: { name: string; source: string }[] = [
  { name: "runtime.json", source: `.state/${env}/runtime.json` },
  { name: "applications.json", source: "config/applications.json" },
  { name: "images.lock.json", source: "config/images.lock.json" },
  { name: "backup-receipt.json", source: `.state/${env}/backup-receipt.json` },
];
for (const input of inputs) {
  if (!(await lstat(input.source)).isFile())
    throw new Error("unsafe recovery input");
  await writeFile(`${dir}/${input.name}`, await readFile(input.source), {
    mode: 0o600,
    flag: "wx",
  });
}
const wireguard = [
  ["wireguard.key", "wireguard.key.age"],
  ["peers.json", "wireguard-peers.json.age"],
] as const;
const present = await Promise.all(
  wireguard.map(async ([source]) => {
    const stat = await lstat(`.state/${env}/${source}`).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    if (stat && !stat.isFile())
      throw new Error("unsafe WireGuard recovery input");
    return !!stat;
  }),
);
if (
  env !== "local" &&
  (present.some(Boolean) || !runtime.cloudflare?.ssh_domain) &&
  !present.every(Boolean)
)
  throw new Error("incomplete WireGuard key and peer inventory");
for (const [index, [source, name]] of wireguard.entries()) {
  if (present[index])
    await exec(
      "age",
      ["-r", recipient, "-o", `${dir}/${name}`, `.state/${env}/${source}`],
      { timeout: 30000 },
    );
}
const { readdir } = await import("node:fs/promises");
const artifacts = [];
for (const name of (await readdir(dir)).sort()) {
  artifacts.push(await recoveryArtifact(dir, name));
}
const body = JSON.stringify({
  version: 1,
  environment: env,
  backup: id,
  artifacts,
});
const signature = createHmac("sha256", secret("BACKUP_HMAC_KEY"))
  .update(body)
  .digest("hex");
await writeFile(`${dir}/manifest.json`, JSON.stringify({ body, signature }), {
  mode: 0o600,
  flag: "wx",
});
await exec(
  process.execPath,
  import.meta.url.endsWith(".js")
    ? ["dist/scripts/verify-recovery.js", dir]
    : ["--import", "tsx", "scripts/verify-recovery.ts", dir],
  { timeout: recoveryVerifyTimeout },
);
console.log(
  JSON.stringify({
    event: "recovery.bundle.created",
    backup: id,
    artifacts: artifacts.length,
  }),
);
