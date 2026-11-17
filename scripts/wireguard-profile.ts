import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { z } from "zod";
const name = z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
    .parse(process.argv[2]),
  address = z.ipv4().parse(process.argv[3]),
  endpoint = z
    .string()
    .regex(/^[a-z0-9.-]+:\d{2,5}$/)
    .parse(process.argv[4]),
  expiry = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .parse(process.argv[5]);
const config = process.argv[6] ?? "config/local.json";
const manifest = z
  .object({
    environment: z.enum(["local", "staging", "production"]),
    wireguard_cidr: z.string(),
  })
  .parse(JSON.parse(await readFile(config, "utf8")));
const exec = promisify(execFile),
  dir = `.state/${manifest.environment}/client-profiles`,
  file = `${dir}/${name}.conf`;
await mkdir(dir, { recursive: true, mode: 0o700 });
let privateKey: string;
try {
  if (!(await lstat(file)).isFile()) throw new Error("unsafe profile");
  privateKey =
    (await readFile(file, "utf8")).match(/^PrivateKey = (.+)$/m)?.[1] ?? "";
  if (!privateKey) throw new Error("invalid existing profile");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  privateKey = (await exec("wg", ["genkey"])).stdout.trim();
}
async function pub(key: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("wg", ["pubkey"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let value = "";
    child.stdout.on("data", (b) => (value += String(b)));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(value.trim())
        : reject(new Error("key derivation failed")),
    );
    child.stdin.end(key + "\n");
  });
}
const publicKey = await pub(privateKey);
await exec(
  "bin/fv",
  [
    "--config",
    config,
    "wireguard",
    "enroll",
    "--name",
    name,
    "--public-key",
    publicKey,
    "--address",
    address,
    "--expires",
    expiry,
  ],
  { timeout: 120000 },
);
const server = await pub(
  (
    await readFile(`.state/${manifest.environment}/wireguard.key`, "utf8")
  ).trim(),
);
const [networkIp, prefix] = manifest.wireguard_cidr.split("/");
const integer = networkIp!
  .split(".")
  .reduce((a, b) => (a * 256 + Number(b)) >>> 0, 0);
const gateway =
  (((integer & (0xffffffff << (32 - Number(prefix)))) >>> 0) + 1) >>> 0;
const network = [24, 16, 8, 0].map((shift) => (gateway >>> shift) & 255);
await writeFile(
  file,
  `[Interface]\nPrivateKey = ${privateKey}\nAddress = ${address}/32\n\n[Peer]\nPublicKey = ${server}\nEndpoint = ${endpoint}\nAllowedIPs = ${network.join(".")}/32\nPersistentKeepalive = 25\n`,
  { mode: 0o600 },
);
console.log(
  `Private profile saved to ${file}. Import it on the named device; no network routes were activated here.`,
);
