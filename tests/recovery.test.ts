import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  rm,
  unlink,
  symlink,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
test("recovery verifier authenticates exact artifacts and rejects tampering, extras and links", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fv-recovery-")),
    exec = promisify(execFile),
    key = "synthetic-independent-verification-key",
    data = Buffer.from("synthetic ciphertext");
  const file = "runtime.env.age";
  const files = [
    file,
    "runtime.json",
    "applications.json",
    "images.lock.json",
    "backup-receipt.json",
  ];
  const contents = {
    version: 1,
    environment: "local",
    backup: "a".repeat(64),
    artifacts: files.map((name) => ({
      name,
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    })),
  };
  const body = JSON.stringify(contents);
  const env: NodeJS.ProcessEnv = { ...process.env, BACKUP_HMAC_KEY: key };
  delete env.BACKUP_HMAC_KEY_FILE;
  const verify = () =>
    exec(
      process.execPath,
      ["--import", "tsx", "scripts/verify-recovery.ts", dir],
      { env, timeout: 30000 },
    );
  try {
    for (const name of files) await writeFile(path.join(dir, name), data);
    const writeManifest = async (value: unknown) => {
      const body = JSON.stringify(value);
      await writeFile(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          body,
          signature: createHmac("sha256", key).update(body).digest("hex"),
        }),
      );
    };
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        body,
        signature: createHmac("sha256", key).update(body).digest("hex"),
      }),
    );
    await verify();
    for (const invalid of [
      { ...contents, environment: "../production" },
      { ...contents, backup: "synthetic" },
      { ...contents, artifacts: [] },
      { ...contents, artifacts: contents.artifacts.slice(1) },
      { ...contents, environment: "production" },
    ]) {
      await writeManifest(invalid);
      await assert.rejects(verify);
    }
    await writeManifest(contents);
    await symlink(dir, `${dir}.link`);
    try {
      await assert.rejects(() =>
        exec(
          process.execPath,
          ["--import", "tsx", "scripts/verify-recovery.ts", `${dir}.link`],
          { env, timeout: 30000 },
        ),
      );
    } finally {
      await unlink(`${dir}.link`);
    }
    await writeFile(path.join(dir, "unlisted.sql"), "synthetic");
    await assert.rejects(verify);
    await unlink(path.join(dir, "unlisted.sql"));
    await writeFile(path.join(dir, file), "tampered");
    await assert.rejects(verify);
    await unlink(path.join(dir, file));
    await symlink("/etc/hosts", path.join(dir, file));
    await assert.rejects(verify);
    await unlink(path.join(dir, file));
    await writeFile(path.join(dir, file), data);
    const runtime = Buffer.from(
      JSON.stringify({
        environment: "staging",
        cloudflare: { ssh_domain: "ssh.example.com" },
      }),
    );
    await writeFile(path.join(dir, "runtime.json"), runtime);
    const tunneled = {
      ...contents,
      environment: "staging",
      artifacts: contents.artifacts.map((artifact) =>
        artifact.name === "runtime.json"
          ? {
              ...artifact,
              size: runtime.length,
              sha256: createHash("sha256").update(runtime).digest("hex"),
            }
          : artifact,
      ),
    };
    await writeManifest(tunneled);
    await verify();
    const loneKey = {
      name: "wireguard.key.age",
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
    await writeFile(path.join(dir, loneKey.name), data);
    await writeManifest({
      ...tunneled,
      artifacts: [...tunneled.artifacts, loneKey],
    });
    await assert.rejects(verify);
    await unlink(path.join(dir, loneKey.name));
    await writeManifest(tunneled);
    await copyFile(path.join(dir, "manifest.json"), `${dir}.manifest`);
    await unlink(path.join(dir, "manifest.json"));
    await symlink(`${dir}.manifest`, path.join(dir, "manifest.json"));
    await assert.rejects(verify);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}.manifest`, { force: true });
  }
});
