import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";

export const vaultwardenArchive = "vaultwarden-data.tar.age";
export const auditSnapshot = "audit.jsonl.age";
export const recoveryVerifyTimeout = 120_000;

export async function recoveryArtifact(directory: string, name: string) {
  if (!/^[a-zA-Z0-9.-]+$/.test(name) || name === "." || name === "..")
    throw new Error("unsafe recovery artifact name");
  const file = path.join(directory, name);
  const stat = await lstat(file);
  const maximum =
    name === vaultwardenArchive || name === auditSnapshot
      ? 4 * 1024 ** 3
      : 1024 ** 2;
  if (!stat.isFile() || stat.size > maximum)
    throw new Error("unsafe recovery artifact");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    if (size > stat.size) throw new Error("recovery artifact changed");
    hash.update(chunk);
  }
  if (size !== stat.size) throw new Error("recovery artifact changed");
  return { name, size, sha256: hash.digest("hex") };
}
