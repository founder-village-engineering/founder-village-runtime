import { readFile, readdir, lstat } from "node:fs/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { secret } from "../packages/database/index.ts";
import {
  auditSnapshot,
  recoveryArtifact,
  vaultwardenArchive,
} from "./recovery-artifact.ts";
if (!process.argv[2]) throw new Error("recovery directory required");
const dir = path.resolve(process.argv[2]);
const directoryStat = await lstat(dir);
if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
  throw new Error("unsafe recovery directory");
const manifestPath = path.join(dir, "manifest.json"),
  manifestStat = await lstat(manifestPath);
if (
  !manifestStat.isFile() ||
  manifestStat.isSymbolicLink() ||
  manifestStat.size > 1024 * 1024
)
  throw new Error("unsafe recovery manifest");
let parsedManifest: unknown;
try {
  parsedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch {
  throw new Error("invalid recovery manifest");
}
const manifest = z
  .object({ body: z.string(), signature: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
  .parse(parsedManifest);
const expected = createHmac("sha256", secret("BACKUP_HMAC_KEY"))
  .update(manifest.body)
  .digest();
if (!timingSafeEqual(expected, Buffer.from(manifest.signature, "hex")))
  throw new Error("recovery signature invalid");
const body = z
  .object({
    version: z.literal(1),
    environment: z.enum(["local", "staging", "production"]),
    backup: z.string().regex(/^[a-f0-9]{64}$/),
    artifacts: z.array(
      z
        .object({
          name: z.enum([
            "runtime.env.age",
            "runtime.json",
            "applications.json",
            "images.lock.json",
            "backup-receipt.json",
            "wireguard.key.age",
            "wireguard-peers.json.age",
            vaultwardenArchive,
            auditSnapshot,
          ]),
          size: z.number().int().nonnegative(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
  })
  .strict()
  .parse(JSON.parse(manifest.body));
const required = [
  "runtime.env.age",
  "runtime.json",
  "applications.json",
  "images.lock.json",
  "backup-receipt.json",
];
if (
  required.some(
    (name) => !body.artifacts.some((artifact) => artifact.name === name),
  )
)
  throw new Error("incomplete recovery artifact-set");
const wanted = ["manifest.json", ...body.artifacts.map((a) => a.name)].sort(),
  actual = (await readdir(dir)).sort();
if (
  JSON.stringify(wanted) !== JSON.stringify(actual) ||
  new Set(wanted).size !== wanted.length
)
  throw new Error("recovery artifact-set mismatch");
for (const a of body.artifacts) {
  const artifact = await recoveryArtifact(dir, a.name);
  if (artifact.size !== a.size || artifact.sha256 !== a.sha256)
    throw new Error("recovery artifact altered");
}
if (body.environment !== "local") {
  const config = z
    .object({
      environment: z.literal(body.environment),
      cloudflare: z.object({ ssh_domain: z.string().min(1).nullish() }),
      vaultwarden_domain: z.string().min(1).nullish(),
      backup: z
        .object({ mode: z.enum(["s3", "workstation"]).optional() })
        .optional(),
    })
    .parse(JSON.parse(await readFile(path.join(dir, "runtime.json"), "utf8")));
  const wireguard = ["wireguard.key.age", "wireguard-peers.json.age"];
  if (
    (!config.cloudflare.ssh_domain ||
      wireguard.some((name) => actual.includes(name))) &&
    !wireguard.every((name) => actual.includes(name))
  )
    throw new Error("incomplete WireGuard recovery artifact-set");
  if (
    Boolean(config.vaultwarden_domain) !== actual.includes(vaultwardenArchive)
  )
    throw new Error("Vaultwarden recovery artifact-set mismatch");
  if (
    (config.backup?.mode === "workstation") !==
    actual.includes(auditSnapshot)
  )
    throw new Error("audit recovery artifact-set mismatch");
}
console.log(
  JSON.stringify({
    event: "recovery.bundle.verified",
    backup: body.backup,
    artifacts: body.artifacts.length,
  }),
);
