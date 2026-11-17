import { readdir, readFile } from "node:fs/promises";
const skip = new Set([
  ".git",
  ".state",
  "secrets",
  "node_modules",
  "target",
  "dist",
  "test-results",
  "playwright-report",
]);
const findings: string[] = [];
async function walk(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(p);
    else if (entry.isFile()) {
      if (/\.(?:m?js)$/.test(p)) findings.push(p);
      const text = await readFile(p, "utf8");
      for (const pattern of [
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
        /\b(?:ghp_|github_pat_|cfut_)[A-Za-z0-9_]{24,}/,
        /AKIA[A-Z0-9]{16}/,
      ])
        if (pattern.test(text)) findings.push(p);
    }
  }
}
await walk(".");
if (findings.length) {
  console.error(
    JSON.stringify({ event: "secret_scan.failed", files: findings }),
  );
  process.exit(1);
}
console.log("source secret scan passed");
