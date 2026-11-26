import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

export async function pinnedSshOptions(
  args: { host: string; knownHosts: string; initialRootPublicKey?: string },
  ipv4?: string,
  sshDomain?: string | null,
) {
  const viaTunnel = isIP(args.host) === 0;
  if (viaTunnel && args.host !== sshDomain)
    throw new Error("SSH hostname must match the configured tunnel");
  if (
    (!viaTunnel && ipv4 !== args.host) ||
    (args.initialRootPublicKey && viaTunnel)
  )
    throw new Error(
      "direct operator SSH requires the bound existing server IPv4",
    );
  const knownHosts = path.resolve(args.knownHosts);
  if (/[\r\n\0%]/.test(knownHosts)) throw new Error("invalid known_hosts path");
  const kh = await lstat(knownHosts);
  if (!kh.isFile() || kh.uid !== process.getuid?.() || (kh.mode & 0o022) !== 0)
    throw new Error("dedicated owner-controlled known_hosts required");
  const bindings = (await readFile(knownHosts, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
  const selected = bindings.filter((parts) => parts[0] === args.host);
  const allowed = new Set([args.host, sshDomain, ipv4]);
  if (
    selected.length !== 1 ||
    bindings.some(
      ([host, algorithm, key]) =>
        !allowed.has(host) ||
        algorithm !== "ssh-ed25519" ||
        key !== selected[0]?.[2] ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(key ?? ""),
    )
  )
    throw new Error(
      "pin one console-verified Ed25519 key for the exact operator host",
    );
  return [
    "-F",
    "/dev/null",
    "-T",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile="${knownHosts.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    "-o",
    "GlobalKnownHostsFile=none",
    "-o",
    "HostKeyAlgorithms=ssh-ed25519",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    ...(viaTunnel
      ? ["-o", "ProxyCommand=cloudflared access ssh --hostname %h"]
      : []),
  ];
}
