import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const revision = process.env.GITHUB_SHA;
if (!revision || !/^[a-f0-9]{40}$/.test(revision))
  throw new Error("release source SHA required");
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const listed = (
  await promisify(execFile)("git", ["ls-files", "-z"], { encoding: "utf8" })
).stdout
  .split("\0")
  .filter(Boolean);
const files = [];
for (const name of listed) {
  if (name.startsWith("/") || name.split("/").includes(".."))
    throw new Error("unsafe source path");
  files.push({ path: name, sha256: hash(await readFile(name)) });
}
await writeFile(
  "source-manifest.json",
  JSON.stringify(
    {
      version: 1,
      revision,
      sourceSha256: hash(await readFile("source.tar")),
      binarySha256: hash(await readFile("target/release/fv")),
      files,
    },
    null,
    2,
  ) + "\n",
);
