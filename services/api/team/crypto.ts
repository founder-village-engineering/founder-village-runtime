import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { secret } from "../../../packages/database/index.ts";

type Kind = "bot" | "conversation" | "message" | "receipt" | "engineering";
function key(): Buffer {
  const value = secret("TEAM_CONTENT_KEY");
  if (!/^[0-9a-f]{64}$/i.test(value))
    throw new Error("invalid team content key");
  return Buffer.from(value, "hex");
}
function context(tenantId: string, kind: Kind, id: string): Buffer {
  return Buffer.from(
    JSON.stringify(["founder-village-team", tenantId, kind, id]),
  );
}

export function sealTeamPayload(
  tenantId: string,
  kind: Kind,
  id: string,
  value: unknown,
): Buffer {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(context(tenantId, kind, id));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
}

export function openTeamPayload(
  tenantId: string,
  kind: Kind,
  id: string,
  value: Buffer,
): unknown {
  if (value.length < 30 || value[0] !== 1)
    throw new Error("invalid encrypted team record");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    value.subarray(1, 13),
  );
  decipher.setAAD(context(tenantId, kind, id));
  decipher.setAuthTag(value.subarray(13, 29));
  return JSON.parse(
    Buffer.concat([
      decipher.update(value.subarray(29)),
      decipher.final(),
    ]).toString("utf8"),
  );
}

export function teamRequestHash(
  tenantId: string,
  actor: string,
  requestKey: string,
  operation: string,
  input: unknown,
): string {
  const signingKey = createHmac("sha256", key())
    .update("founder-village-team request receipts v1")
    .digest();
  return createHmac("sha256", signingKey)
    .update(JSON.stringify([tenantId, actor, requestKey, operation, input]))
    .digest("hex");
}
