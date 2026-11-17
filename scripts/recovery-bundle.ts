import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { createHmac, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { secret } from "../packages/database/index.ts";
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
    ["--import", "tsx", "scripts/verify-recovery.ts", dir],
    { timeout: 30000 },
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
try {
  if (!(await lstat(`.state/${env}/wireguard.key`)).isFile())
    throw new Error("unsafe WireGuard key");
  await exec(
    "age",
    [
      "-r",
      recipient,
      "-o",
      `${dir}/wireguard.key.age`,
      `.state/${env}/wireguard.key`,
    ],
    { timeout: 30000 },
  );
} catch (e) {
  if (env !== "local" || (e as NodeJS.ErrnoException).code !== "ENOENT")
    throw e;
}
try {
  if (!(await lstat(`.state/${env}/peers.json`)).isFile())
    throw new Error("unsafe WireGuard peer catalog");
  await exec(
    "age",
    [
      "-r",
      recipient,
      "-o",
      `${dir}/wireguard-peers.json.age`,
      `.state/${env}/peers.json`,
    ],
    { timeout: 30000 },
  );
} catch (e) {
  if (env !== "local" || (e as NodeJS.ErrnoException).code !== "ENOENT")
    throw e;
}
const { readdir } = await import("node:fs/promises");
const artifacts = [];
for (const name of (await readdir(dir)).sort()) {
  const stat = await lstat(`${dir}/${name}`);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error("unsafe recovery artifact");
  const data = await readFile(`${dir}/${name}`);
  artifacts.push({
    name,
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
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
  ["--import", "tsx", "scripts/verify-recovery.ts", dir],
  { timeout: 30000 },
);
console.log(
  JSON.stringify({
    event: "recovery.bundle.created",
    backup: id,
    artifacts: artifacts.length,
  }),
);
