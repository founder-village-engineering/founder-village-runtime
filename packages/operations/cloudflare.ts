import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";
import { dnsRecord } from "../contracts/index.ts";
import { secret } from "../database/index.ts";
const exec = promisify(execFile);
export type DnsRecord = z.infer<typeof dnsRecord>;
const record = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean().optional(),
  ttl: z.number(),
});
export type Existing = z.infer<typeof record>;
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export function normalize(r: Existing | DnsRecord | null) {
  return r
    ? {
        type: r.type,
        name: r.name,
        content: r.content,
        proxied: r.proxied ?? false,
        ttl: r.proxied ? 1 : r.ttl,
      }
    : null;
}
export async function runCloudflareCli(
  args: string[],
  auth: { token: string } | { profile: "foundervillage" },
): Promise<unknown> {
  const binary = secret("CF_BINARY"),
    expected = secret("CF_SHA256");
  if (!binary.startsWith("/") || expected.length !== 64)
    throw new Error("untrusted cf executable");
  if (
    createHash("sha256")
      .update(await readFile(binary))
      .digest("hex") !== expected
  )
    throw new Error("cf checksum mismatch");
  const profile = "profile" in auth ? auth.profile : undefined;
  const workdir = profile
    ? await mkdtemp(path.join(tmpdir(), "fv-cf-profile-"))
    : secret("CF_WORK_DIR");
  try {
    await mkdir(workdir, { recursive: true, mode: 0o700 });
    const cliArgs = profile ? [...args, "--profile", profile] : args;
    const { stdout } = await exec(process.execPath, [binary, ...cliArgs], {
      cwd: workdir,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        ...(profile
          ? {
              HOME: process.env.HOME,
              XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
              XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
              CLOUDFLARE_AUTH_USE_KEYRING:
                process.env.CLOUDFLARE_AUTH_USE_KEYRING,
            }
          : {}),
        CLOUDFLARE_API_TOKEN: "token" in auth ? auth.token : undefined,
        CLOUDFLARE_ACCOUNT_ID: secret("CF_ACCOUNT_ID"),
        CLOUDFLARE_API_BASE_URL: "https://api.cloudflare.com/client/v4",
        CI: "true",
      },
      encoding: "utf8",
    });
    return JSON.parse(stdout);
  } catch {
    throw new Error("cloudflare_operation_failed");
  } finally {
    if (profile) await rm(workdir, { recursive: true, force: true });
  }
}

export class Cloudflare {
  constructor(
    private readonly write = false,
    private readonly profile?: "foundervillage",
  ) {}
  async call(args: string[]): Promise<unknown> {
    return runCloudflareCli(
      args,
      this.profile
        ? { profile: this.profile }
        : { token: secret(this.write ? "CF_WRITE_TOKEN" : "CF_READ_TOKEN") },
    );
  }
  async verifyZoneOwnership(): Promise<void> {
    const id = secret("CF_ZONE_ID");
    const zone = await this.call(["zones", "get", "--zone", id]);
    const expected = z.object({
      id: z.literal(id),
      name: z.literal(secret("CF_ZONE_NAME")),
      status: z.literal("active"),
      account: z.object({ id: z.literal(secret("CF_ACCOUNT_ID")) }),
    });
    if (!expected.safeParse(zone).success)
      throw new Error(
        "active Cloudflare zone does not match the configured account and zone",
      );
  }
  allowed(name: string) {
    const allowed = secret("CF_MANAGED_NAMES").split(",");
    const suffix = `.${secret("CF_ZONE_NAME")}`;
    const label = name.endsWith(suffix) ? name.slice(0, -suffix.length) : "";
    if (
      !allowed.includes(name) ||
      name.endsWith(".fv") ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    )
      throw Object.assign(new Error("unmanaged name"), { statusCode: 403 });
  }
  async inventory(name: string): Promise<Existing | null> {
    this.allowed(name);
    const all: Existing[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.call([
        "dns",
        "records",
        "list",
        "--zone",
        secret("CF_ZONE_ID"),
        "--name",
        name,
        "--page",
        String(page),
        "--per-page",
        "100",
      ]);
      const rows = z.array(record).parse(result);
      all.push(...rows);
      if (rows.length < 100) break;
      if (page === 100) throw new Error("DNS pagination exceeded");
    }
    if (all.length > 1)
      throw Object.assign(new Error("ambiguous DNS record"), {
        statusCode: 409,
      });
    return all[0] ?? null;
  }
  async apply(
    name: string,
    before: Existing | null,
    desired: DnsRecord | null,
  ): Promise<void> {
    if (process.env.CF_TUNNEL_NAMES?.split(",").includes(name))
      throw new Error(
        "tunnel DNS records are provisioned through the tunnel workflow",
      );
    await this.writeRecord(name, before, desired);
  }

  async ensureTunnelRecord(
    name: string,
    tunnelId: string,
    before: Existing | null,
    verifyOnly: boolean,
  ): Promise<void> {
    this.allowed(name);
    if (!process.env.CF_TUNNEL_NAMES?.split(",").includes(name))
      throw new Error("hostname is outside the tunnel configuration");
    const desired = {
      name,
      type: "CNAME" as const,
      content: `${z.uuid().parse(tunnelId)}.cfargotunnel.com`,
      proxied: true,
      ttl: 300,
    };
    if (fingerprint(normalize(before)) === fingerprint(normalize(desired)))
      return;
    if (
      verifyOnly ||
      (before &&
        (before.type !== desired.type || before.content !== desired.content))
    )
      throw new Error("tunnel DNS record requires review");
    await this.writeRecord(name, before, desired);
  }

  private async writeRecord(
    name: string,
    before: Existing | null,
    desired: DnsRecord | null,
  ): Promise<void> {
    if (!this.write) throw new Error("read-only adapter");
    const current = await this.inventory(name);
    if (fingerprint(current) !== fingerprint(before))
      throw Object.assign(new Error("DNS drift"), { statusCode: 409 });
    if (desired) {
      dnsRecord.parse(desired);
      if (desired.name !== name) throw new Error("name mismatch");
      const args = ["dns", "records", current ? "update" : "create"];
      if (current) args.push(current.id);
      args.push(
        "--zone",
        secret("CF_ZONE_ID"),
        "--body",
        JSON.stringify(desired.proxied ? { ...desired, ttl: 1 } : desired),
      );
      await this.call(args);
    } else if (current)
      await this.call([
        "dns",
        "records",
        "delete",
        current.id,
        "--zone",
        secret("CF_ZONE_ID"),
        "--force",
      ]);
    const after = await this.inventory(name);
    if (fingerprint(normalize(after)) !== fingerprint(normalize(desired)))
      throw new Error("DNS postcondition failed");
  }
}
