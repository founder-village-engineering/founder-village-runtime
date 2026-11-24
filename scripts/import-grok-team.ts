import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../packages/database/index.ts";
import {
  archiveSchema,
  mappingSchema,
  inventory,
  validateArchive,
  ImportFailure,
  requireImport,
} from "./team-import/archive.ts";
import { importArchive } from "./team-import/store.ts";

async function readPrivate(path: string) {
  const actual = await realpath(path);
  const repo = spawnSync(
    "git",
    ["-C", dirname(actual), "rev-parse", "--is-inside-work-tree"],
    { stdio: "ignore" },
  );
  requireImport(
    !repo.error && repo.status === 128,
    "Store input files outside a Git checkout.",
  );
  const file = await open(
    path,
    constants.O_NOFOLLOW | constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const st = await file.stat();
    requireImport(
      st.isFile() &&
        st.nlink === 1 &&
        (st.mode & 0o077) === 0 &&
        st.uid === process.getuid?.(),
      "Input must be an owner-only regular file.",
    );
    return await file.readFile();
  } finally {
    await file.close();
  }
}

// Scan decoded leaf strings so embedded newlines and JSON escapes have their original meaning.
function scanStrings(value: unknown) {
  const strings: string[] = [];
  JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string") strings.push(item);
    return item;
  });
  const scan = spawnSync(
    "gitleaks",
    [
      "stdin",
      "--config",
      fileURLToPath(new URL("../.gitleaks.toml", import.meta.url)),
      "--ignore-gitleaks-allow",
      "--redact=100",
      "--exit-code=42",
    ],
    { input: strings.join("\n"), stdio: ["pipe", "ignore", "ignore"] },
  );
  requireImport(
    !scan.error && scan.status === 0,
    scan.status === 42
      ? "A credential pattern was detected in the source."
      : "The private source scan did not complete.",
  );
}
async function main() {
  const [mode, archivePath, mappingPath, ...extra] = process.argv.slice(2);
  requireImport(
    (mode === "plan" || mode === "apply") &&
      archivePath &&
      mappingPath &&
      !extra.length,
    "Usage: node --import tsx scripts/import-grok-team.ts plan|apply ARCHIVE_JSON MAPPING_JSON",
  );
  const [bytes, mapBytes] = await Promise.all([
    readPrivate(archivePath),
    readPrivate(mappingPath),
  ]);
  const config = mappingSchema.safeParse(JSON.parse(mapBytes.toString("utf8")));
  requireImport(
    config.success,
    "The mapping has unsupported or missing fields.",
  );
  requireImport(
    createHash("sha256").update(bytes).digest("hex") ===
      config.data.exportSha256,
    "The archive digest differs from the reviewed mapping.",
  );
  const parsed = archiveSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  requireImport(
    parsed.success,
    "The archive has unsupported or missing fields.",
  );
  const archive = parsed.data;
  validateArchive(archive, config.data);
  scanStrings(archive);
  const counts = inventory(archive);
  if (mode === "plan") {
    console.log(JSON.stringify({ mode, reviewed: counts }));
    return;
  }
  const db = pool("MIGRATION_FOUNDER_VILLAGE_TEAM_DATABASE_URL");
  try {
    const inserted = await importArchive(db, archive, config.data);
    console.log(JSON.stringify({ mode, reviewed: counts, inserted }));
  } finally {
    await db.end();
  }
}
main().catch((error: unknown) => {
  // JSON and SQL parser errors can contain complete private records.
  console.error(
    error instanceof ImportFailure
      ? error.message
      : "Import failed. Check private input, database configuration, schema and content-key access.",
  );
  process.exitCode = 1;
});
