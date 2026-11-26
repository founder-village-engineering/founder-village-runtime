import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

class ScanError extends Error {}

type Finding = { rule: string; path: string; line?: number; commit?: string };
type GitleaksFinding = {
  RuleID: string;
  File: string;
  StartLine: number;
  Commit: string;
};

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const findingsExitCode = 42;
const maxBuffer = 128 * 1024 * 1024;

function git(args: string[], operation: string): Buffer {
  const result = spawnSync("git", args, {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer,
  });
  if (result.error || result.status !== 0)
    throw new ScanError(`Git could not ${operation}.`);
  return result.stdout;
}

function pathsToScan(staged: boolean): Set<string> {
  // A Git hook can receive GIT_INDEX_FILE for a temporary commit index.
  const args = staged
    ? [
        "diff",
        "--cached",
        "--no-renames",
        "--name-only",
        "--diff-filter=ACMT",
        "-z",
      ]
    : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  const paths = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(git(args, "list files for the secret scan"));
  return new Set(paths.split("\0").filter(Boolean));
}

function pathViolation(file: string): string | undefined {
  const name = basename(file).toLowerCase();
  if (
    /^backups(?:\/|$)/i.test(file) ||
    /(?:^|\/)(?:\.state|secrets)(?:\/|$)/i.test(file) ||
    /(?:\.private\.json|\.tfstate[^/]*|\.(?:key|p8|p12|pfx|jks|kdbx))$/.test(
      name,
    ) ||
    /^(?:\.git-credentials|\.netrc|id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(
      name,
    ) ||
    (/^\.(?:env|dev\.vars)(?:\..*)?$/.test(name) &&
      name !== ".env.example" &&
      name !== ".dev.vars.example")
  )
    return "private-file";
  if (/\.[cm]?js$/i.test(name)) return "javascript-source";
}

function displayPath(path: string): string {
  // Filenames can themselves contain credential-shaped strings.
  return path
    .replace(/(?:ghp_|github_pat_|cfut_)[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, "[redacted]")
    .replace(/[A-Za-z0-9_+=-]{32,}/g, "[redacted]");
}

function scanWithGitleaks(args: string[], cwd: string): Finding[] {
  if (lstatSync(join(cwd, ".gitleaksignore"), { throwIfNoEntry: false }))
    throw new ScanError(
      "Put reviewed scan exceptions in .gitleaks.toml instead of .gitleaksignore.",
    );
  const result = spawnSync(
    "gitleaks",
    [
      ...args,
      "--config",
      join(root, ".gitleaks.toml"),
      "--redact=100",
      "--ignore-gitleaks-allow",
      "--max-archive-depth=2",
      "--no-banner",
      "--report-format=json",
      "--report-path=-",
      `--exit-code=${findingsExitCode}`,
    ],
    { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer, timeout: 120_000 },
  );
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
    throw new ScanError("Install Gitleaks and make it available on PATH.");
  if (
    result.error ||
    (result.status !== 0 && result.status !== findingsExitCode)
  )
    throw new ScanError(
      "Gitleaks could not complete the scan. Check its version and the repository configuration.",
    );
  if (result.status === 0) return [];

  // Keep the report in memory and emit only location metadata.
  const findings = JSON.parse(result.stdout.toString()) as GitleaksFinding[];
  if (!Array.isArray(findings) || !findings.length)
    throw new ScanError("Gitleaks reported findings without usable locations.");
  return findings.map(({ RuleID, File, StartLine, Commit }) => ({
    rule: RuleID,
    path: displayPath(File),
    line: StartLine,
    commit: /^[0-9a-f]{40,64}$/.test(Commit) ? Commit : undefined,
  }));
}

function workspaceStat(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    // An unstaged file can replace a directory that still exists in the index.
    if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
  }
}

function scanFiles(staged: boolean): { files: number; findings: Finding[] } {
  const snapshot = mkdtempSync(join(tmpdir(), "fv-secret-scan-"));
  const findings: Finding[] = [];
  let files = 0;
  try {
    for (const file of pathsToScan(staged)) {
      const source = join(root, file);
      const target = join(snapshot, file);
      let link = false;
      if (!staged) {
        const stat = workspaceStat(source);
        if (!stat || stat.isDirectory()) continue;
        if (realpathSync(dirname(source)) !== dirname(source))
          throw new ScanError(
            "A Git-visible file is inside a symlinked directory.",
          );
        link = stat.isSymbolicLink();
        if (!link && !stat.isFile())
          throw new ScanError(
            "A Git-visible path is not a regular file or symlink.",
          );
      }
      const rule = pathViolation(file);
      if (rule) {
        findings.push({ rule, path: displayPath(file) });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      if (staged || link) {
        const bytes = staged
          ? git(["cat-file", "blob", `:${file}`], "read a staged blob")
          : readlinkSync(source, { encoding: "buffer" });
        writeFileSync(target, bytes, { mode: 0o600 });
      } else {
        copyFileSync(source, target);
      }
      files++;
    }
    findings.push(...scanWithGitleaks(["dir", "."], snapshot));
    return { files, findings };
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function scanHistory(): Finding[] {
  if (
    git(["rev-parse", "--is-shallow-repository"], "inspect history")
      .toString()
      .trim() !== "false"
  )
    throw new ScanError(
      "Fetch the full Git history before running the history scan.",
    );
  return scanWithGitleaks(
    [
      "git",
      "--log-opts=--all --full-history -m --no-ext-diff --no-textconv --no-renames",
      ".",
    ],
    root,
  );
}

try {
  const [flag, ...extra] = process.argv.slice(2);
  if (extra.length || (flag && flag !== "--staged" && flag !== "--history"))
    throw new ScanError(
      "Usage: npm run security:scan -- [--staged | --history]",
    );
  const scope =
    flag === "--history"
      ? "history"
      : flag === "--staged"
        ? "staged"
        : "worktree";
  const { files, findings } =
    scope === "history"
      ? { files: undefined, findings: scanHistory() }
      : scanFiles(scope === "staged");
  if (findings.length) {
    console.error(
      JSON.stringify({ event: "secret_scan.failed", scope, findings }, null, 2),
    );
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ event: "secret_scan.passed", scope, files }));
  }
} catch (error) {
  console.error(
    error instanceof ScanError
      ? error.message
      : "Secret scan could not complete safely.",
  );
  process.exitCode = 1;
}
