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
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { verifyAuditSnapshot } from "../scripts/verify-audit-snapshot.ts";

test("audit verification requires the exact signed UTF-8 lines and terminal signature", async (t) => {
  const previous = process.env;
  process.env = {
    FV_ENV: "production",
    AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
  };
  t.after(() => {
    process.env = previous;
  });
  const backup = "b".repeat(64);
  const payload = [
    { version: 1, environment: "production", backup },
    { id: "1", event: "entrada café" },
    { count: 1, lastId: "1" },
  ]
    .map((record) => JSON.stringify(record) + "\n")
    .join("");
  const signature = createHmac("sha256", process.env.AUDIT_HMAC_KEY!)
    .update(payload)
    .digest("hex");
  const valid = payload + JSON.stringify({ signature }) + "\n";
  const bytes = Buffer.from(valid);
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  assert.equal(
    await verifyAuditSnapshot(
      Readable.from([bytes.subarray(0, split), bytes.subarray(split)]),
      backup,
    ),
    1,
  );
  for (const changed of [
    valid.replace("café", "cafe"),
    valid.replaceAll("\n", "\r\n"),
    valid.trimEnd(),
    payload,
  ])
    await assert.rejects(verifyAuditSnapshot(Readable.from([changed]), backup));
});
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
    const vaultRuntime = Buffer.from(
      JSON.stringify({
        ...JSON.parse(runtime.toString()),
        vaultwarden_domain: "vault.example.com",
      }),
    );
    const vaultArchive = Buffer.alloc(1024 ** 2 + 1, 1);
    const artifact = (name: string, bytes: Buffer) => ({
      name,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const vault = {
      ...tunneled,
      artifacts: tunneled.artifacts.map((entry) =>
        entry.name === "runtime.json"
          ? artifact(entry.name, vaultRuntime)
          : entry,
      ),
    };
    await writeFile(path.join(dir, "runtime.json"), vaultRuntime);
    await writeManifest(vault);
    await assert.rejects(verify, /Vaultwarden recovery artifact-set mismatch/);
    const vaultCopy = artifact("vaultwarden-data.tar.age", vaultArchive);
    await writeFile(path.join(dir, vaultCopy.name), vaultArchive);
    await writeManifest({
      ...vault,
      artifacts: [...vault.artifacts, vaultCopy],
    });
    await verify();
    vaultArchive[0] = 2;
    await writeFile(path.join(dir, vaultCopy.name), vaultArchive);
    await assert.rejects(verify, /recovery artifact altered/);
    await unlink(path.join(dir, vaultCopy.name));
    const workstationConfig = Buffer.from(
      JSON.stringify({
        ...JSON.parse(runtime.toString()),
        backup: { mode: "workstation" },
      }),
    );
    await writeFile(path.join(dir, "runtime.json"), workstationConfig);
    const workstation = {
      ...tunneled,
      artifacts: tunneled.artifacts.map((entry) =>
        entry.name === "runtime.json"
          ? artifact(entry.name, workstationConfig)
          : entry,
      ),
    };
    await writeManifest(workstation);
    await assert.rejects(verify, /audit recovery artifact-set mismatch/);
    const audit = Buffer.from("synthetic encrypted audit snapshot");
    const auditCopy = artifact("audit.jsonl.age", audit);
    await writeFile(path.join(dir, auditCopy.name), audit);
    await writeManifest({
      ...workstation,
      artifacts: [...workstation.artifacts, auditCopy],
    });
    await verify();
    await writeFile(path.join(dir, auditCopy.name), "changed");
    await assert.rejects(verify, /recovery artifact altered/);
    await unlink(path.join(dir, auditCopy.name));
    await writeFile(path.join(dir, "runtime.json"), runtime);
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
