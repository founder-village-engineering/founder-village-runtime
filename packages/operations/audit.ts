import { createHmac } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type pg from "pg";
import { secret, transaction } from "../database/index.ts";
export async function archiveAudit(db: pg.Pool) {
  const rows = await transaction(db, async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const invalid = await c.query(
      "SELECT id FROM (SELECT *,lag(hash,1,repeat('0',64)) OVER(ORDER BY id) AS expected_previous FROM control.audit) a WHERE previous_hash<>expected_previous OR hash<>encode(digest(concat_ws('|',previous_hash,actor,event,resource,outcome,COALESCE(operation_id::text,''),created_at::text),'sha256'),'hex') LIMIT 1",
    );
    if (invalid.rowCount) throw new Error("audit integrity invalid");
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
