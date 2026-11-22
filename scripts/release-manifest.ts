import { lstat, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const revision = process.env.GITHUB_SHA;
if (!revision || !/^[a-f0-9]{40}$/.test(revision))
  throw new Error("release source SHA required");
const parts = process.argv[2];
if (!parts) throw new Error("native release artifacts required");
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const listed = (
  await promisify(execFile)("git", ["ls-files", "-z"], { encoding: "utf8" })
).stdout
  .split("\0")
  .filter(Boolean);
const files = [];
for (const name of listed) {
  if (
    name.startsWith("/") ||
    name.split("/").includes("..") ||
    !(await lstat(name)).isFile()
  )
    throw new Error("unsafe source path");
  files.push({ path: name, sha256: hash(await readFile(name)) });
}
await writeFile(
  "source-manifest.json",
  JSON.stringify(
    {
      version: 2,
      revision,
      image: (await readFile("image-digest.txt", "utf8")).trim(),
      sourceSha256: hash(await readFile("source.tar")),
      binaries: Object.fromEntries(
        await Promise.all(
          ["amd64", "arm64"].map(async (arch) => [
            arch,
            hash(await readFile(path.join(parts, `native-${arch}`, "fv"))),
          ]),
        ),
      ),
      files,
    },
    null,
    2,
  ) + "\n",
);
