import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const runtimeConfig = z
  .object({
    environment: z.enum(["local", "staging", "production"]),
    api_domain: z.string(),
    admin_domain: z.string(),
    cloudflare: z
      .object({
        zone_name: z.string(),
        managed_names: z.array(z.string()),
      })
      .passthrough(),
  })
  .passthrough();

const localRoutes = z.record(z.string(), z.number().int().min(1024).max(65535));

const servicesByPort = new Map([
  [43801, "api"],
  [43802, "admin-api"],
  [43804, "monitor"],
  [43805, "workers"],
]);

export type DomainRoute = {
  subdomain: string;
  hostname: string;
  service: string;
  target: string;
  source: "Local route" | "Runtime domain" | "Managed DNS";
};

function subdomain(hostname: string, zone: string): string {
  const suffix = `.${zone}`;
  const label = hostname.endsWith(suffix)
    ? hostname.slice(0, -suffix.length)
    : "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    throw new Error(`invalid one-label domain: ${hostname}`);
  return label;
}

export async function configuredDomains(
  root = process.cwd(),
): Promise<DomainRoute[]> {
  const stateDirectory =
    process.env.FV_STATE_DIR ?? `.state/${process.env.FV_ENV ?? ""}`;
  const runtime = runtimeConfig.parse(
    JSON.parse(
      await readFile(
        path.resolve(root, stateDirectory, "runtime.json"),
        "utf8",
      ),
    ),
  );

  if (runtime.environment === "local") {
    const routes = localRoutes.parse(
      JSON.parse(
        await readFile(path.resolve(root, "config/local-domains.json"), "utf8"),
      ),
    );
    return Object.entries(routes).map(([hostname, port]) => {
      const label = subdomain(hostname, "fv");
      return {
        subdomain: label,
        hostname,
        service: servicesByPort.get(port) ?? label,
        target: `127.0.0.1:${port}`,
        source: "Local route",
      };
    });
  }

  const services = new Map([
    [runtime.api_domain, "api"],
    [runtime.admin_domain, "admin-api"],
  ]);
  for (const hostname of runtime.cloudflare.managed_names)
    if (!services.has(hostname)) services.set(hostname, "managed-dns");

  return [...services].map(([hostname, service]) => ({
    subdomain: subdomain(hostname, runtime.cloudflare.zone_name),
    hostname,
    service,
    target: "Cloudflare DNS",
    source:
      service === "managed-dns"
        ? ("Managed DNS" as const)
        : ("Runtime domain" as const),
  }));
}
