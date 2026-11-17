import {
  readFile,
  mkdir,
  writeFile,
  rename,
  mkdtemp,
  chmod,
  rm,
  lstat,
} from "node:fs/promises";
import { parseEnv } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { fingerprint } from "../packages/operations/cloudflare.ts";
const exec = promisify(execFile),
  environment = z
    .enum(["local", "staging", "production"])
    .parse(process.argv[2]),
  bundle = process.argv[3] ?? "",
  identity = process.argv[4] ?? "";
await exec(
  process.execPath,
  ["--import", "tsx", "scripts/verify-recovery.ts", bundle],
  { timeout: 30000 },
);
const envelope = JSON.parse(
  await readFile(`${bundle}/manifest.json`, "utf8"),
) as { body: string };
const manifest = JSON.parse(envelope.body) as { environment: string };
if (manifest.environment !== environment)
  throw new Error("recovery environment mismatch");
if (
  fingerprint(
    JSON.parse(await readFile(`${bundle}/applications.json`, "utf8")),
  ) !==
  fingerprint(JSON.parse(await readFile("config/applications.json", "utf8")))
)
  throw new Error(
    "application inventory differs; recover the matching source revision first",
  );
await mkdir(".state", { recursive: true, mode: 0o700 });
const temporaryDirectory = await mkdtemp(`.state/${environment}.recovery-`);
const temp = `${temporaryDirectory}/runtime.env`;
try {
  await exec(
    "age",
    ["--decrypt", "-i", identity, "-o", temp, `${bundle}/runtime.env.age`],
    { timeout: 30000 },
  );
  await chmod(temp, 0o600);
  const bytes = await readFile(temp),
    values = parseEnv(bytes.toString());
  if (
    values.FV_ENV !== environment ||
    !values.POSTGRES_PASSWORD ||
    !values.BACKUP_HMAC_KEY ||
    !values.HASURA_JWT_SECRET
  )
    throw new Error("invalid decrypted runtime catalog");
  const destination = `.state/${environment}.env`;
  try {
    const stat = await lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("unsafe destination");
    await writeFile(
      `${destination}.preserved-${Date.now()}`,
      await readFile(destination),
      { mode: 0o600, flag: "wx" },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await writeFile(temp, bytes, { mode: 0o600 });
  await rename(temp, destination);
  console.log(
    "Validated runtime secrets restored. Reconcile revocations and recovery keys before exposing services.",
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
