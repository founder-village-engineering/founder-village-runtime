import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertNativeElf,
  parseRuntimeFiles,
  permittedSourcePath,
  verifySavedImages,
  verifyWorkstationSignature,
} from "../scripts/local-release.ts";

test("only safe source paths can enter the workstation build snapshot", () => {
  assert.equal(permittedSourcePath("config/production.example.json"), true);
  assert.equal(permittedSourcePath("infra/compose/compose.yml"), true);
  assert.equal(permittedSourcePath("packages/example/internal.ts"), true);
  for (const path of [
    "config/production.private.json",
    ".state/owner.json",
    ".git/config",
    ".git-credentials",
    "secrets/access-token",
    "nested/.env.production",
    "../outside",
    "/absolute",
    "safe//ambiguous",
    "nested/id_ed25519",
    "dist/generated.js",
    "safe/.gitleaksignore",
  ]) {
    assert.equal(permittedSourcePath(path), false, path);
  }
});

test("signed image identities distinguish engine IDs and reject incomplete or wrong-platform Docker saves", (context) => {
  const scratch = mkdtempSync(join(tmpdir(), "fv-local-image-test-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const archive = join(scratch, "image.tar");
  const revision = "ab".repeat(20);
  const tag = "fv-runtime:local-" + revision;
  mkdirSync(join(scratch, "blobs/sha256"), { recursive: true });
  const write = (name: string, data: object) =>
    writeFileSync(join(scratch, name), JSON.stringify(data));
  const blob = (data: string) => {
    const digest = createHash("sha256").update(data).digest("hex");
    const path = "blobs/sha256/" + digest;
    writeFileSync(join(scratch, path), data);
    return { path, digest: "sha256:" + digest };
  };
  const config = blob(
    JSON.stringify({
      os: "linux",
      architecture: "amd64",
      config: { Labels: { "org.opencontainers.image.revision": revision } },
    }),
  );
  const layer = blob("synthetic disposable layer");
  const manifest = blob(
    JSON.stringify({
      config: { digest: config.digest },
      layers: [{ digest: layer.digest }],
    }),
  );
  write("manifest.json", [
    { Config: config.path, RepoTags: [tag], Layers: [layer.path] },
  ]);
  write("index.json", {
    manifests: [
      {
        digest: manifest.digest,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        annotations: { "io.containerd.image.name": "docker.io/library/" + tag },
      },
    ],
  });
  const save = (...layers: string[]) =>
    execFileSync(
      "tar",
      [
        "-cf",
        archive,
        "index.json",
        "manifest.json",
        config.path,
        manifest.path,
        ...layers,
      ],
      { cwd: scratch },
    );
  save(layer.path);
  const expected = { tag, id: config.digest, manifestId: manifest.digest };
  for (const engineId of [config.digest, manifest.digest]) {
    const result = verifySavedImages(
      archive,
      { app: { tag, engineId } },
      "amd64",
      revision,
    );
    assert.deepEqual(result.app, expected);
  }
  const observed = { app: { tag, engineId: manifest.digest } };
  assert.throws(
    () => verifySavedImages(archive, observed, "arm64", revision),
    /did not match/,
  );
  save();
  assert.throws(
    () => verifySavedImages(archive, observed, "amd64", revision),
    /missing an expected runtime layer/,
  );
});

test("the requested architecture is checked against real ELF header fields", () => {
  const elf = Buffer.alloc(64);
  elf.writeUInt32BE(0x7f454c46);
  elf.set([2, 1, 1], 4);
  elf.writeUInt16LE(3, 16);
  elf.writeUInt16LE(62, 18);
  assert.doesNotThrow(() => assertNativeElf(elf, "amd64"));
  assert.throws(() => assertNativeElf(elf, "arm64"), /native Linux ELF/);
  elf.writeUInt16LE(183, 18);
  assert.doesNotThrow(() => assertNativeElf(elf, "arm64"));
  elf[4] = 1;
  assert.throws(() => assertNativeElf(elf, "arm64"), /native Linux ELF/);
  assert.throws(
    () => assertNativeElf(Buffer.from("ELF"), "amd64"),
    /native Linux ELF/,
  );
});

test("host inventory is exact, unambiguous and includes required entry points", () => {
  const sha256 = "ab".repeat(32);
  const paths = [
    "node",
    "dist/packages/database/migrate.js",
    "dist/scripts/materialize-service-env.js",
    "dist/services/domain-worker/main.js",
    "dist/services/monitor/main.js",
    "node_modules/cf/bin/cf",
    "node_modules/example/a file.js",
  ];
  const inventory = (names: string[]) =>
    Buffer.from(names.map((path) => sha256 + "  " + path + "\0").join(""));
  assert.deepEqual(
    parseRuntimeFiles(inventory(paths)),
    paths.map((path) => ({ path, sha256 })),
  );
  assert.throws(
    () => parseRuntimeFiles(inventory(paths.slice(1))),
    /required host runtime file/,
  );
  for (const extra of [
    "node",
    "node_modules/../outside",
    "config/private.json",
    "dist/\nscript.js",
  ]) {
    assert.throws(
      () => parseRuntimeFiles(inventory([...paths, extra])),
      /unsafe entry/,
    );
  }
  assert.throws(
    () => parseRuntimeFiles(inventory(paths).subarray(0, -1)),
    /incomplete/,
  );
});

test("independent Ed25519 verification binds exact manifest bytes and release principal", (context) => {
  const scratch = mkdtempSync(join(tmpdir(), "fv-local-signature-test-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const key = join(scratch, "fixture");
  const manifest = join(scratch, "source-manifest.json");
  const pin = join(scratch, "allowed_signers");
  const openSsh = (args: string[]) =>
    execFileSync("ssh-keygen", args, { stdio: "ignore" });
  openSsh(["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const original = '{ "version": 3, "distribution": "workstation" }\n';
  writeFileSync(manifest, original);
  const publicKey = readFileSync(key + ".pub", "utf8");
  openSsh(["-Y", "sign", "-f", key, "-n", "fv-release-v3", manifest]);
  writeFileSync(
    pin,
    'founder-village-release namespaces="fv-release-v3" ' + publicKey,
  );
  assert.doesNotThrow(() => verifyWorkstationSignature(manifest, pin));
  writeFileSync(manifest, original + " ");
  assert.throws(() => verifyWorkstationSignature(manifest, pin), /ssh-keygen/);
  writeFileSync(manifest, original);
  writeFileSync(pin, "different-principal " + publicKey);
  assert.throws(() => verifyWorkstationSignature(manifest, pin), /ssh-keygen/);
});
