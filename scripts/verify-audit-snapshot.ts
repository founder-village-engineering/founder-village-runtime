import { createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { secret } from "../packages/database/index.ts";

// JSON.stringify in the exporter escapes embedded line breaks. Preserve the
// signed framing exactly, including the final LF and any multi-byte text split
// across stream chunks.
async function* snapshotLines(input: NodeJS.ReadableStream) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let tail = "";
  for await (const chunk of input) {
    const text = tail + decoder.decode(Buffer.from(chunk), { stream: true });
    const lines = text.split("\n");
    tail = lines.pop()!;
    for (const line of lines) {
      if (line.includes("\r")) throw new Error("invalid audit framing");
      yield line;
    }
  }
  if (tail || decoder.decode()) throw new Error("incomplete audit record");
}

export async function verifyAuditSnapshot(
  input: NodeJS.ReadableStream,
  backup: string,
) {
  if (!/^[0-9a-f]{64}$/.test(backup))
    throw new Error("expected backup fingerprint");
  const hmac = createHmac("sha256", secret("AUDIT_HMAC_KEY"));
  let lineNumber = 0,
    count = 0,
    last = "0",
    summary = false,
    verified = false;
  for await (const line of snapshotLines(input)) {
    const entry = JSON.parse(line);
    if (verified) throw new Error("unexpected trailing record");
    if (summary) {
      if (
        Object.keys(entry).length !== 1 ||
        typeof entry.signature !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.signature) ||
        !timingSafeEqual(hmac.digest(), Buffer.from(entry.signature, "hex"))
      )
        throw new Error("invalid audit signature");
      verified = true;
      continue;
    }
    hmac.update(line + "\n");
    if (lineNumber++ === 0) {
      if (
        entry.version !== 1 ||
        entry.environment !== secret("FV_ENV") ||
        entry.backup !== backup
      )
        throw new Error("audit snapshot identity mismatch");
    } else if (typeof entry.id === "string") {
      if (!/^[1-9]\d*$/.test(entry.id) || BigInt(last) >= BigInt(entry.id))
        throw new Error("invalid audit record sequence");
      last = entry.id;
      count++;
    } else {
      if (entry.count !== count || entry.lastId !== last)
        throw new Error("invalid audit summary");
      summary = true;
    }
  }
  if (!verified) throw new Error("missing audit signature");
  return count;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await verifyAuditSnapshot(process.stdin, process.argv[2] ?? "").then(
    (count) =>
      console.log(JSON.stringify({ event: "audit.snapshot.verified", count })),
    () => {
      console.error("Audit snapshot verification failed.");
      process.exitCode = 1;
    },
  );
