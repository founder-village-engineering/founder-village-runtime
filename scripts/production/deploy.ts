import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { prepare } from "../production-bootstrap.ts";
import { machineAccess } from "./access.ts";
import { cloudApi } from "./discovery.ts";
import { pinnedSshOptions } from "./ssh.ts";
import {
  BootstrapError,
  digest,
  exists,
  json,
  privateDirectory,
  privateText,
  publish,
  run,
  runQuiet,
  stage,
} from "./workstation.ts";

type Production = Awaited<ReturnType<typeof prepare>>;
const node = (
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  timeout?: number,
) =>
  run(
    process.execPath,
    ["--import", "tsx", "scripts/" + script + ".ts", ...args],
    env,
    undefined,
    timeout,
  );
async function build(p: Production) {
  if (await run("git", ["status", "--porcelain", "--untracked-files=normal"]))
    throw new BootstrapError(
      "Production release signing requires a clean runtime checkout.",
    );
  if (!(await exists(p.releaseDir))) {
    await runQuiet(
      process.execPath,
      [
        "scripts/local-release.ts",
        "--arch",
        p.manifest.provider.architecture,
        "--out",
        p.releaseDir,
        "--signing-key",
        p.keys.signer,
        "--allowed-signers",
        p.keys.signers,
      ],
      {},
      7200_000,
    );
  }
  const manifest = join(p.releaseDir, "source-manifest.json"),
    bytes = await readFile(manifest, "utf8");
  await run(
    "ssh-keygen",
    [
      "-Y",
      "verify",
      "-f",
      p.keys.signers,
      "-I",
      "founder-village-release",
      "-n",
      "fv-release-v3",
      "-s",
      manifest + ".sig",
    ],
    {},
    bytes,
  );
  z.object({
    revision: z.literal(p.revision),
    architecture: z.literal(p.manifest.provider.architecture),
    version: z.literal(3),
    distribution: z.literal("workstation"),
  }).parse(JSON.parse(bytes));
}
async function frontendSource(home: string) {
  const sibling = resolve("../founder-village-frontends");
  const managed =
    !(await exists(sibling)) ||
    Boolean(
      await run("git", [
        "-C",
        sibling,
        "status",
        "--porcelain",
        "--untracked-files=normal",
      ]),
    );
  const repo = managed ? join(home, "frontends") : sibling;
  const origin =
    "https://github.com/founder-village-engineering/founder-village-frontends.git";
  if (managed && !(await exists(repo))) {
    const dest = await mkdtemp(join(home, ".checkout-"));
    try {
      await run("git", [
        "clone",
        "--quiet",
        "--branch",
        "main",
        "--single-branch",
        "--depth=1",
        origin,
        dest,
      ]);
      await rename(dest, repo);
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  }
  const git = (...args: string[]) => run("git", ["-C", repo, ...args]);
  const upstream = await git("remote", "get-url", "origin");
  if (
    ![
      origin,
      origin.replace(/\.git$/, ""),
      origin.replace("https://github.com/", "git@github.com:"),
    ].includes(upstream) ||
    (await git("status", "--porcelain", "--untracked-files=normal"))
  )
    throw new Error("Untrusted or dirty frontend checkout");
  if (managed) {
    await git("fetch", "--quiet", "--depth=1", "origin", "main");
    await git("checkout", "--quiet", "--detach", "FETCH_HEAD");
  }
  if (!(await exists(join(repo, "node_modules/.bin/wrangler"))))
    await runQuiet(
      "npm",
      ["--prefix", repo, "ci", "--no-audit", "--no-fund"],
      {},
      600_000,
    );
  return {
    repo,
    revision: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .parse(await git("rev-parse", "HEAD")),
  };
}

async function firstLogin(p: Production) {
  const addr = p.manifest.provider.existing_server.ipv4;
  const opts = await pinnedSshOptions(
    { host: addr, knownHosts: p.bootstrap.knownHosts },
    addr,
    p.manifest.cloudflare.ssh_domain,
  );
  const check = 'test "$(hostname -s)" = ' + p.manifest.project;
  try {
    await run("ssh", [
      ...opts,
      "-i",
      p.keys.operator,
      "-l",
      "fv",
      addr,
      check + " && sudo -n true",
    ]);
  } catch (error) {
    if (!p.bootstrap.initialRootIdentityFile) throw error;
    await run("ssh", [
      ...opts,
      "-i",
      p.bootstrap.initialRootIdentityFile,
      "-l",
      "root",
      addr,
      check,
    ]);
  }
}
async function retry<T>(operation: () => Promise<T>) {
  for (let i = 0; ; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
async function publicRuntime(p: Production) {
  await node("probe", [], {
    PUBLIC_API_URL: "https://" + p.manifest.api_domain,
    PUBLIC_API_REVISION: p.revision,
  });
  const res = await fetch("https://" + p.manifest.admin_domain + "/", {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  await res.body?.cancel();
  const dest = new URL(res.headers.get("location") ?? "");
  if (
    res.status < 300 ||
    res.status >= 400 ||
    dest.origin !==
      "https://" +
        p.manifest.cloudflare.access_team +
        ".cloudflareaccess.com" ||
    !dest.pathname.startsWith("/cdn-cgi/access/login/")
  )
    throw new Error("Unexpected admin Access challenge");
}

export async function deploy(p: Production) {
  const frontend = await stage(
    "The production frontend checkout or dependencies could not be verified.",
    () => frontendSource(p.home),
  );
  await stage("Signed workstation release build or verification failed.", () =>
    build(p),
  );
  const machine = await stage(
    "Access deployment service credential could not be reconciled.",
    () =>
      machineAccess(
        p.home,
        p.manifest.cloudflare.account_id,
        p.manifest.provider.existing_server.id,
        p.keys.operatorPublic,
        cloudApi(p.values.CLOUDFLARE_PROVISION_TOKEN!),
      ),
  );
  const cfWork = join(p.home, "cloudflare");
  await privateDirectory(cfWork);
  const cf = {
    CF_READ_TOKEN: p.values.CF_READ_TOKEN,
    CF_WRITE_TOKEN: p.values.CF_WRITE_TOKEN,
    CLOUDFLARE_PROVISION_TOKEN: p.values.CLOUDFLARE_PROVISION_TOKEN,
    ACCESS_ADMIN_EMAILS: p.values.ACCESS_ADMIN_EMAILS,
    ACCESS_SSH_EMAILS: p.values.ACCESS_SSH_EMAILS,
    CF_WORK_DIR: cfWork,
    FV_CLOUDFLARE_WORKSTATION: "1",
    FV_SSH_ACCESS_TOKEN_ID: machine.id,
  };
  const hc = { FV_HCLOUD_TOKEN: p.values.FV_HCLOUD_TOKEN };
  const temp = await mkdtemp(join(p.home, ".apply-")),
    file = join(temp, "production.private.json");
  const remoteConfig = "config/production.private.json",
    cli = "bin/fv --config " + remoteConfig;
  const ipv4 = p.manifest.provider.existing_server.ipv4,
    tunnel = p.manifest.cloudflare.ssh_domain;
  const ssh = async (host: string, command: string, input?: string) => {
    const options = await pinnedSshOptions(
      { host, knownHosts: p.bootstrap.knownHosts },
      ipv4,
      tunnel,
    );
    return run(
      "ssh",
      [...options, "-i", p.keys.operator, "-l", "fv", host, command],
      host === tunnel ? machine.env : {},
      input,
      3600_000,
    );
  };
  const hostRun = (host: string, command: string, input?: string) =>
    ssh(host, "cd /opt/founder-village && sudo -n " + command, input);
  const provision = (action: string, ...extra: string[]) =>
    run(
      "bin/fv",
      ["--config", file, "provision", action, ...extra],
      { ...hc, ...(extra.length ? machine.env : {}) },
      undefined,
      600_000,
    );
  const cfStep = (action: string) =>
    node("cloudflare-bootstrap", [file, action], cf, 600_000);
  const probeSsh = () => ssh(tunnel, "sudo -n true");
  const firewall = async () =>
    z
      .object({
        owned: z.literal(true),
        project_isolated: z.literal(true),
        firewall_rules_match: z.literal(true),
        public_inbound_closed: z.literal(true),
      })
      .parse(JSON.parse(await provision("status")));
  const pages = (action: string) =>
    node(
      "frontend-production",
      [
        action,
        "--app",
        "founder-village-app",
        "--frontends-root",
        frontend.repo,
        "--config",
        file,
        "--revision",
        p.revision,
      ],
      action === "verify"
        ? {}
        : {
            CLOUDFLARE_API_TOKEN: p.values.FV_PAGES_API_TOKEN,
            CLOUDFLARE_ACCOUNT_ID: p.manifest.cloudflare.account_id,
            FV_PAGES_CLOUDFLARE_BINDING: p.pagesFile,
          },
      900_000,
    );
  const receipt = join(p.home, "deployment.json");
  const desired = (manifest: typeof p.manifest) =>
    json({
      runtime: p.revision,
      frontend: frontend.revision,
      settings: digest(
        json([
          manifest,
          p.runtime,
          cf.ACCESS_ADMIN_EMAILS,
          cf.ACCESS_SSH_EMAILS,
          machine.id,
        ]),
      ),
    });
  try {
    await publish(file, json(p.manifest));
    if (
      p.sealed &&
      (await exists(receipt)) &&
      (await privateText(receipt)) === desired(p.manifest)
    ) {
      try {
        await firewall();
        await cfStep("verify");
        await probeSsh();
        await hostRun(tunnel, cli + " release verify");
        await pages("verify");
        console.log(
          "Verified the existing production deployment and public firewall.",
        );
        return false;
      } catch {
        console.log(
          "The deployment needs reconciliation after live verification.",
        );
      }
    }
    await stage(
      "The Tunnel routes, DNS or Access policies could not be reconciled.",
      () => cfStep("apply"),
    );
    const connector = (
      await privateText(join(cfWork, "production/connector.token"))
    ).trim();
    if (!/^[A-Za-z0-9_+/=-]{40,8000}$/.test(connector))
      throw new BootstrapError("Invalid connector credential.");
    if (!p.sealed) {
      await stage(
        "Hetzner bootstrap firewall or network reconciliation failed.",
        () => provision("apply"),
      );
      await stage(
        "The bound VM did not accept its pinned machine enrollment identity.",
        () => retry(() => firstLogin(p)),
      );
    }
    const route = p.bootstrap.host;
    const bootstrapFile = join(temp, "bootstrap.private.json");
    await publish(bootstrapFile, json({ ...p.bootstrap, config: file }));
    await stage(
      "Pinned SSH enrollment or signed runtime installation failed.",
      () =>
        node(
          "remote-bootstrap",
          [bootstrapFile],
          route === tunnel ? machine.env : {},
          7200_000,
        ),
    );
    console.log("Signed runtime installed over pinned SSH.");
    await stage(
      "Runtime catalog installation or native service initialization failed.",
      async () => {
        const candidate =
          ".fv-releases/" +
          p.revision +
          "/target/release/fv --config " +
          remoteConfig;
        await hostRun(
          route,
          candidate + " host install-catalog",
          json({ ...p.runtime, CLOUDFLARE_TUNNEL_TOKEN: connector }),
        );
        await hostRun(route, "systemctl enable --now fv-runtime.service");
        await hostRun(route, cli + " render");
        const escrow = z
          .object({
            fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
            encrypted: z
              .string()
              .regex(
                /^-----BEGIN AGE ENCRYPTED FILE-----[\s\S]+-----END AGE ENCRYPTED FILE-----\s*$/,
              ),
          })
          .parse(
            JSON.parse(
              await hostRun(route, candidate + " host escrow-backup-verifier"),
            ),
          );
        const escrowPath = join(p.home, "identity", "backup-verifier");
        await publish(escrowPath + ".sha256", escrow.fingerprint + "\n");
        await publish(escrowPath + ".age", escrow.encrypted, true);
        await hostRun(
          route,
          './.fv-current/node "$(realpath dist/scripts/materialize-service-env.js)" production',
        );
      },
    );
    await stage(
      "Offsite backup, immutable read-back or isolated restore failed.",
      async () => {
        await hostRun(route, cli + " backup verify").catch(() =>
          hostRun(route, cli + " backup capture"),
        );
        await hostRun(route, cli + " backup verify");
        await hostRun(route, cli + " backup restore-drill");
      },
    );
    await stage(
      "Signed runtime promotion, readiness or ingress startup failed.",
      async () => {
        const candidate =
          ".fv-releases/" +
          p.revision +
          "/target/release/fv --config " +
          remoteConfig;
        await hostRun(
          route,
          candidate + " release promote --revision " + p.revision,
        );
        await hostRun(route, cli + " doctor");
        await hostRun(
          route,
          "systemctl enable --now fv-ops.service fv-domain-worker.service fv-monitor.service fv-backup.timer fv-restore.timer fv-audit.timer fv-ingress.service",
        );
      },
    );
    await stage(
      "External Tunnel, API revision, admin Access challenge or pinned machine SSH proof failed.",
      () =>
        retry(async () => {
          await cfStep("verify");
          await publicRuntime(p);
          await probeSsh();
        }),
    );
    // Persist intent before touching either firewall. A retry always uses the
    // Tunnel after this point, including if only the host side completed.
    await publish(p.sealedFile, p.sealIntent);
    const live = JSON.parse(await privateText(file)) as typeof p.manifest;
    live.ssh_cidrs = [];
    await publish(file, json(live), true);
    await stage(
      "Public SSH lockdown or post-lockdown verification failed.",
      async () => {
        await hostRun(tunnel, cli + " host seal-ssh");
        await provision(
          "apply",
          "--tunnel-known-hosts",
          p.bootstrap.knownHosts,
          "--tunnel-identity",
          p.keys.operator,
        );
        await firewall();
        await probeSsh();
        await publicRuntime(p);
      },
    );
    console.log(
      "Verified serving revision, protected admin, machine SSH and closed public ingress.",
    );
    for (const action of ["provision", "deploy", "verify"]) {
      await stage("Founder Village Pages " + action + " failed.", () =>
        pages(action),
      );
    }
    await publish(receipt, desired(live), true);
    console.log(
      "Verified production Pages deployment and registered frontend origins.",
    );
    return json(p.manifest) !== json(live);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
