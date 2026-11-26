import { execFile } from "node:child_process";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import { exportAuditSnapshot } from "../packages/operations/audit.ts";

export async function encryptAuditSnapshot(
  db: pg.Pool,
  backup: string,
  recipient: string,
  output: string,
) {
  const work = await mkdtemp(join(dirname(output), ".audit-"));
  const file = join(work, "snapshot.age");
  const encrypted = promisify(execFile)("age", ["-r", recipient, "-o", file], {
    env: { PATH: process.env.PATH },
    timeout: 600_000,
  });
  const input = encrypted.child.stdin!;
  input.on("error", () => {});
  const exported = exportAuditSnapshot(
    db,
    backup,
    (line) =>
      new Promise<void>((resolve, reject) =>
        input.write(line, (err) => (err ? reject(err) : resolve())),
      ),
  ).finally(() => input.end());
  try {
    await Promise.all([encrypted, exported]);
    await rename(file, output);
  } catch {
    input.destroy();
    encrypted.child.kill();
    await Promise.allSettled([encrypted, exported]);
    throw new Error("audit snapshot verification or encryption failed");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
