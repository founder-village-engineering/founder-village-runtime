import { createHmac, timingSafeEqual } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type pg from "pg";
import { secret, transaction } from "../database/index.ts";
async function verifyLedger(c: pg.PoolClient) {
  const invalid = await c.query(
    "SELECT id FROM (SELECT *,lag(hash,1,repeat('0',64)) OVER(ORDER BY id) AS expected_previous FROM control.audit) a WHERE previous_hash<>expected_previous OR hash<>encode(digest(concat_ws('|',previous_hash,actor,event,resource,outcome,COALESCE(operation_id::text,''),created_at::text),'sha256'),'hex') LIMIT 1",
  );
  if (invalid.rowCount) throw new Error("audit integrity invalid");
}

function anchorSignature(id: string, hash: string) {
  return createHmac("sha256", secret("AUDIT_HMAC_KEY"))
    .update(JSON.stringify(["audit-anchor-v1", secret("FV_ENV"), id, hash]))
    .digest();
}

async function verifiedAnchors(c: pg.PoolClient) {
  await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await verifyLedger(c);
  const anchors = await c.query<{
    id: string;
    hash: string;
    signature: string;
  }>(
    "SELECT k.last_id AS id, a.hash, k.signature FROM control.audit_anchors k LEFT JOIN control.audit a ON a.id=k.last_id ORDER BY k.last_id",
  );
  for (const { id, hash, signature } of anchors.rows) {
    if (
      !hash ||
      !/^[0-9a-f]{64}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(signature, "hex"), anchorSignature(id, hash))
    )
      throw new Error("audit checkpoint integrity invalid");
  }
  return anchors.rows.at(-1)?.id ?? "0";
}

// The PostgreSQL backup includes the append-only ledger and these authenticated
// tips. S3's independently uploaded segment checkpoints remain separate.
async function checkpointAudit(db: pg.Pool) {
  return transaction(db, async (c) => {
    const after = await verifiedAnchors(c);
    const { rows } = await c.query<{ id: string; hash: string; count: string }>(
      "SELECT id,hash,count(*) OVER() AS count FROM control.audit WHERE id>$1 ORDER BY id DESC LIMIT 1",
      [after],
    );
    const latest = rows[0];
    if (!latest) return { key: "", signature: "", count: 0 };
    const signature = anchorSignature(latest.id, latest.hash).toString("hex");
    await c.query(
      "INSERT INTO control.audit_anchors(last_id,signature) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [latest.id, signature],
    );
    return {
      key: "ledger/" + latest.id,
      signature,
      count: Number(latest.count),
    };
  });
}

// Each line, including its newline, is authenticated. The final line contains
// the HMAC of all preceding lines. Preserve the exact PostgreSQL timestamp text.
export async function exportAuditSnapshot(
  db: pg.Pool,
  backup: string,
  write: (line: string) => Promise<void>,
) {
  await transaction(db, async (c) => {
    await verifiedAnchors(c);
    const hmac = createHmac("sha256", secret("AUDIT_HMAC_KEY"));
    const emit = async (record: unknown) => {
      const line = JSON.stringify(record) + "\n";
      hmac.update(line);
      await write(line);
    };
    await emit({ version: 1, environment: secret("FV_ENV"), backup });
    let last = "0",
      count = 0;
    for (;;) {
      const batch = await c.query(
        "SELECT id, actor, event, resource, outcome, operation_id, created_at::text AS created_at, previous_hash, hash FROM control.audit WHERE id>$1 ORDER BY id LIMIT 1000",
        [last],
      );
      for (const entry of batch.rows) await emit(entry);
      count += batch.rows.length;
      if (batch.rows.length) last = batch.rows.at(-1)!.id;
      if (batch.rows.length < 1000) break;
    }
    await emit({ count, lastId: last });
    await write(JSON.stringify({ signature: hmac.digest("hex") }) + "\n");
  });
}

export async function archiveAudit(db: pg.Pool) {
  if (process.env.BACKUP_MODE === "workstation") return checkpointAudit(db);
  if (process.env.BACKUP_MODE && process.env.BACKUP_MODE !== "s3")
    throw new Error("unknown audit storage mode");
  const rows = await transaction(db, async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await verifyLedger(c);
    return (
      await c.query(
        "SELECT * FROM control.audit WHERE id>COALESCE((SELECT max(last_id) FROM control.audit_checkpoints),0) ORDER BY id LIMIT 1000",
      )
    ).rows;
  });
  if (!rows.length) return { key: "", signature: "", count: 0 };
  const body = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      entries: rows,
    }),
    signature = createHmac("sha256", secret("AUDIT_HMAC_KEY"))
      .update(body)
      .digest("hex");
  const client = new S3Client({
    region: secret("AUDIT_REGION"),
    endpoint: secret("AUDIT_ENDPOINT"),
    forcePathStyle: true,
    credentials: {
      accessKeyId: secret("AUDIT_ACCESS_KEY"),
      secretAccessKey: secret("AUDIT_SECRET_KEY"),
    },
  });
  const key = `audit/${process.env.FV_ENV}/${Date.now()}-${signature}.json`;
  await client.send(
    new PutObjectCommand({
      Bucket: secret("AUDIT_BUCKET"),
      Key: key,
      Body: JSON.stringify({ body, signature }),
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
      IfNoneMatch: "*",
    }),
  );
  await db.query(
    "INSERT INTO control.audit_checkpoints(last_id,object_key,signature) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [rows.at(-1)!.id, key, signature],
  );
  return { key, signature, count: rows.length };
}
