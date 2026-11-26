import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const hmac = (key: string, value: string) =>
  createHmac("sha256", key).update(value).digest("hex");
const compact = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const pub = "ssh.foundervillage.org";
const ip = "192.0.2.40";
const namespace = "fv-workstation-backup-receipt-v1";
const body = (d: { backup: string; sha256: string; size: number }) =>
  `fv-workstation-backup-v1\n${d.backup}\n${d.sha256}\n${d.size}\n`;

async function syntheticHost() {
  const args = process.argv.slice(3);
  const host = args.at(-2),
    cmd = args.at(-1);
  assert.ok(
    cmd?.startsWith(
      "cd /opt/founder-village && sudo -n bin/fv --config config/production.private.json backup ",
    ),
  );
  assert.ok(
    args.includes("StrictHostKeyChecking=yes") &&
      args.includes("GlobalKnownHostsFile=none"),
  );
  assert.equal(
    args.includes("ProxyCommand=cloudflared access ssh --hostname %h"),
    host === pub,
  );
  const secret = process.env.TUNNEL_SERVICE_TOKEN_SECRET;
  assert.equal(
    host === pub ? sha(secret ?? "") : secret,
    host === pub ? await readFile("../machine.sha", "utf8") : undefined,
  );
  assert.ok(host === pub || host === ip);
  const action = cmd!.split(" ").at(-1)!;
  await appendFile(
    "../requests",
    action + (host === pub ? ":tunnel\n" : ":direct\n"),
  );
  const failure = await readFile("../fail", "utf8");
  if (action === "capture" && failure === "stale") {
    await writeFile("../fail", "");
    return;
  }
  if (failure === action || (action === "export-info" && failure === "stale")) {
    process.exitCode = 1;
    return;
  }
  const descriptor = JSON.parse(await readFile("../descriptor", "utf8"));
  if (action === "export-info")
    return void process.stdout.write(JSON.stringify(descriptor));
  if (action === "export")
    return void process.stdout.write(await readFile("../archive"));
  if (action === "verify") {
    assert.equal(await readFile("../last-drilled", "utf8"), descriptor.backup);
    return;
  }
  assert.equal(action, "import-drill");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const packet = Buffer.concat(chunks);
  const size = packet.readUInt32BE();
  assert.ok(size > 0 && size <= 4096);
  const sig = packet.subarray(4, 4 + size),
    bytes = packet.subarray(4 + size);
  assert.ok(sig.toString().endsWith("-----END SSH SIGNATURE-----\n"));
  await writeFile("../last.sig", sig, { mode: 0o600 });
  execFileSync(
    "ssh-keygen",
    [
      "-Y",
      "verify",
      "-f",
      "../allowed",
      "-I",
      "operator",
      "-n",
      namespace,
      "-s",
      "../last.sig",
    ],
    { input: body(descriptor), stdio: ["pipe", "ignore", "ignore"] },
  );
  assert.equal(bytes.length, descriptor.size);
  assert.equal(sha(bytes), descriptor.sha256);
  await writeFile("../last-drilled", descriptor.backup);
}

if (process.argv[2] === "--synthetic-ssh") {
  await syntheticHost().catch(() => {
    process.exitCode = 1;
  });
} else
  test("public workstation backup commands authenticate, restore, reuse and safely retire streamed snapshots", async () => {
    const temp = await realpath(await mkdtemp(join(tmpdir(), "fv-backup-")));
    const source = fileURLToPath(new URL("..", import.meta.url));
    const repo = join(temp, "checkout"),
      home = join(temp, "production");
    const gen = "generation-" + "a".repeat(64),
      state = join(home, gen);
    const identity = join(home, "identity"),
      operator = join(identity, "operator");
    const backupRoot = join(repo, "backups"),
      fakeBin = join(temp, "bin");
    const key = randomBytes(32).toString("hex");
    const account = "a".repeat(32),
      server = 128;
    const privateFile = (file: string, contents: string | Buffer) =>
      writeFile(file, contents, { mode: 0o600 });
    const env = {
      PATH: fakeBin + ":" + process.env.PATH,
      HOME: temp,
      FV_PRODUCTION_HOME: home,
    };
    const command = (...args: string[]) =>
      exec(
        process.execPath,
        ["--import", "tsx", "scripts/workstation-backup.ts", ...args],
        { cwd: repo, env, timeout: 30_000 },
      );
    async function remoteGeneration(label: string, bytes: Buffer) {
      const d = {
        version: 1,
        backup: sha(label),
        sha256: sha(bytes),
        size: bytes.length,
      };
      await privateFile(
        join(temp, "descriptor"),
        compact({ ...d, signature: hmac(key, body(d)) }),
      );
      await privateFile(join(temp, "archive"), bytes);
      return d;
    }
    async function requests() {
      return (await readFile(join(temp, "requests"), "utf8"))
        .trim()
        .split("\n");
    }
    const shaCount = async (action: string) =>
      (await requests()).filter((row) => row.startsWith(action + ":")).length;
    try {
      for (const folder of [join(repo, "scripts"), identity, state, fakeBin])
        await mkdir(folder, { recursive: true, mode: 0o700 });
      await symlink(gen, join(home, "current"));
      await copyFile(
        join(source, "scripts/workstation-backup.ts"),
        join(repo, "scripts/workstation-backup.ts"),
      );
      await symlink(
        join(source, "scripts/production"),
        join(repo, "scripts/production"),
      );
      await symlink(join(source, "node_modules"), join(repo, "node_modules"));
      await privateFile(join(repo, "package.json"), '{"type":"module"}');
      await privateFile(join(temp, "requests"), "");
      await privateFile(join(temp, "fail"), "");
      await privateFile(join(temp, "verifier"), key);
      await privateFile(join(identity, "recovery.agekey"), "fixture");
      await privateFile(join(identity, "backup-verifier.age"), "fixture");
      await privateFile(join(identity, "backup-verifier.sha256"), sha(key));
      await exec("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        operator,
      ]);
      const operatorPublic = (await readFile(operator + ".pub", "utf8"))
        .trim()
        .split(" ")
        .slice(0, 2)
        .join(" ");
      await privateFile(
        join(temp, "allowed"),
        "operator " + operatorPublic + "\n",
      );
      const machine = sha(compact([account, server, operatorPublic])).slice(
          0,
          24,
        ),
        machineSecret = randomBytes(32).toString("hex");
      await privateFile(
        join(home, "access-" + machine + ".json"),
        compact({
          id: randomUUID(),
          name: "fv-production-ssh-" + machine,
          client_id: "fixture.access",
          client_secret: machineSecret,
          expires_at: new Date(Date.now() + 29 * 86400_000).toISOString(),
        }),
      );
      await privateFile(join(temp, "machine.sha"), sha(machineSecret));
      await privateFile(
        join(state, "known_hosts"),
        [ip, pub].map((host) => host + " " + operatorPublic + "\n").join(""),
      );
      await privateFile(
        join(state, "production.private.json"),
        compact({
          environment: "production",
          provider: { existing_server: { id: server, ipv4: ip } },
          cloudflare: { account_id: account, ssh_domain: pub },
          backup: {
            mode: "workstation",
            retention_days: 30,
            rto_seconds: 14400,
          },
        }),
      );
      await privateFile(
        join(state, "bootstrap.private.json"),
        compact({
          host: ip,
          knownHosts: join(home, "current/known_hosts"),
          identityFile: operator,
        }),
      );
      const shell = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
      await writeFile(
        join(fakeBin, "ssh"),
        "#!/bin/sh\nexec " +
          shell(process.execPath) +
          " --import tsx " +
          shell(fileURLToPath(import.meta.url)) +
          ' --synthetic-ssh "$@"\n',
        { mode: 0o700 },
      );
      await writeFile(
        join(fakeBin, "age"),
        "#!/bin/sh\ncat >/dev/null\ncat ../verifier\n",
        { mode: 0o700 },
      );
      const first = await remoteGeneration("first", randomBytes(1 << 17)),
        folder = join(backupRoot, first.backup);
      await command("pull", "--deployment-route");
      assert.deepEqual(await requests(), [
        "export-info:direct",
        "export:direct",
        "import-drill:direct",
        "verify:direct",
      ]);
      assert.equal((await stat(folder)).mode & 0o777, 0o700);
      for (const name of ["snapshot.tar", "descriptor.json", "verified.json"])
        assert.equal((await stat(join(folder, name))).mode & 0o777, 0o600);
      await privateFile(join(temp, "fail"), "stale");
      await command("pull"); // Scheduled pull refreshes a stale host and reuses the verified local copy.
      assert.deepEqual((await requests()).slice(4), [
        "export-info:tunnel",
        "capture:tunnel",
        "export-info:tunnel",
        "verify:tunnel",
      ]);
      const archive = join(folder, "snapshot.tar");
      const snapshot = await readFile(archive);
      await privateFile(archive, Buffer.alloc(snapshot.length));
      await assert.rejects(command("verify"));
      await command("pull");
      assert.deepEqual(await readFile(archive), snapshot);
      assert.equal(await shaCount("import-drill"), 1);
      const verifiedAt = Date.now() - 31 * 86400_000;
      await privateFile(
        join(folder, "verified.json"),
        compact({
          verifiedAt,
          signature: hmac(
            key,
            `fv-workstation-restore-v1\n${first.backup}\n${first.sha256}\n${verifiedAt}\n`,
          ),
        }),
      );
      const nextBytes = randomBytes(8187),
        second = await remoteGeneration("second", nextBytes);
      const dest = join(backupRoot, second.backup),
        saved = await readFile(join(temp, "descriptor"));
      await privateFile(
        join(temp, "descriptor"),
        compact({ ...JSON.parse(saved.toString()), signature: "0".repeat(64) }),
      );
      const downloads = await shaCount("export");
      await assert.rejects(command("pull"));
      assert.equal(await shaCount("export"), downloads);
      const oversized = { ...second, size: Number.MAX_SAFE_INTEGER };
      await privateFile(
        join(temp, "descriptor"),
        compact({ ...oversized, signature: hmac(key, body(oversized)) }),
      );
      await assert.rejects(
        command("pull"),
        /Insufficient workstation disk space/,
      );
      assert.equal(await shaCount("export"), downloads);
      await privateFile(join(temp, "descriptor"), saved);
      await privateFile(join(temp, "archive"), Buffer.alloc(nextBytes.length));
      await assert.rejects(command("pull")); // Signed descriptor but corrupted transfer.
      assert.ok(!(await readdir(backupRoot)).includes(second.backup));
      await privateFile(join(temp, "archive"), nextBytes);
      await privateFile(join(temp, "fail"), "import-drill");
      await assert.rejects(command("pull"));
      assert.ok((await readdir(backupRoot)).includes(first.backup));
      assert.ok(!(await readdir(dest)).includes("verified.json"));
      const beforeRetry = await shaCount("export");
      await privateFile(join(temp, "fail"), "");
      await command("pull");
      assert.equal(await shaCount("export"), beforeRetry);
      assert.ok(!(await readdir(backupRoot)).includes(first.backup));
      await unlink(join(fakeBin, "ssh"));
      await rm(state, { recursive: true }); // A lost host and deployment binding do not prevent recovery.
      await command("verify");
      await command("verify", second.backup);
      await assert.rejects(command("verify", "../outside"));
      await chmod(join(dest, "snapshot.tar"), 0o644);
      await assert.rejects(command("verify"));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

if (process.argv[2] !== "--synthetic-ssh")
  test("backup download and upload budgets permit the full configured restore deadline", async () => {
    const { transferDeadlineMs } =
      await import("../scripts/workstation-backup.ts");
    assert.equal(transferDeadlineMs("export", 14400), 7_200_000);
    assert.equal(transferDeadlineMs("import-drill", 14400), 21_600_000);
    assert.equal(transferDeadlineMs("import-drill", 30), 7_230_000);
    for (const invalid of [0, -1, 0.5, 2 ** 31])
      assert.throws(() => transferDeadlineMs("import-drill", invalid));
  });
