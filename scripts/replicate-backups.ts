import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  mkdir,
  mkdtemp,
  rm,
  readFile,
  readdir,
  statfs,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createHash, createHmac } from "node:crypto";
import { secret } from "../packages/database/index.ts";
const source = new S3Client({
  endpoint: secret("BACKUP_S3_ENDPOINT"),
  region: secret("BACKUP_S3_REGION"),
  forcePathStyle: true,
  credentials: {
    accessKeyId: secret("BACKUP_S3_KEY"),
    secretAccessKey: secret("BACKUP_S3_SECRET"),
  },
});
const dest = new S3Client({
  endpoint: secret("IMMUTABLE_ENDPOINT"),
  region: secret("IMMUTABLE_REGION"),
  forcePathStyle: true,
  credentials: {
    accessKeyId: secret("IMMUTABLE_ACCESS_KEY"),
    secretAccessKey: secret("IMMUTABLE_SECRET_KEY"),
  },
});
const prefix = `snapshots/${secret("FV_ENV")}/${new Date().toISOString().replaceAll(":", "-")}`;
let continuation: string | undefined;
const manifest = [];
await mkdir(".state/transfers", { recursive: true, mode: 0o700 });
const temp = await mkdtemp(".state/transfers/copy-");
try {
  do {
    const listing = await source.send(
      new ListObjectsV2Command({
        Bucket: secret("BACKUP_S3_BUCKET"),
        Prefix: "founder-village/",
        ContinuationToken: continuation,
        MaxKeys: 100,
      }),
    );
    for (const object of listing.Contents ?? []) {
      if (!object.Key) continue;
      if (object.Size === undefined) throw new Error("missing object size");
      if (object.Size > 4 * 1024 ** 3)
        throw new Error("object exceeds transfer capacity budget");
      const space = await statfs(temp);
      if (space.bavail * space.bsize < object.Size + 1024 ** 3)
        throw new Error("insufficient transfer headroom");
      const result = await source.send(
        new GetObjectCommand({
          Bucket: secret("BACKUP_S3_BUCKET"),
          Key: object.Key,
          IfMatch: object.ETag,
        }),
      );
      if (!result.Body) throw new Error("missing backup object");
      const hash = createHash("sha256");
      await pipeline(
        result.Body as NodeJS.ReadableStream,
        new Transform({
          transform(chunk, _encoding, cb) {
            hash.update(chunk);
            cb(null, chunk);
          },
        }),
        createWriteStream(`${temp}/artifact`, { mode: 0o600 }),
      );
      const sha = hash.digest("base64"),
        key = `${prefix}/${object.Key}`;
      const uploaded = await dest.send(
        new PutObjectCommand({
          Bucket: secret("IMMUTABLE_BUCKET"),
          Key: key,
          Body: createReadStream(`${temp}/artifact`),
          ContentLength: object.Size,
          ChecksumSHA256: sha,
          IfNoneMatch: "*",
          ObjectLockMode: "COMPLIANCE",
          ObjectLockRetainUntilDate: new Date(
            Date.now() +
              Number(process.env.IMMUTABLE_RETENTION_DAYS ?? 90) * 86400000,
          ),
        }),
      );
      const head = await dest.send(
        new HeadObjectCommand({
          Bucket: secret("IMMUTABLE_BUCKET"),
          Key: key,
          VersionId: uploaded.VersionId,
          ChecksumMode: "ENABLED",
        }),
      );
      if (
        head.ChecksumSHA256 !== sha ||
        head.ContentLength !== object.Size ||
        head.ObjectLockMode !== "COMPLIANCE"
      )
        throw new Error("immutable-copy verification failed");
      manifest.push({
        key,
        version: uploaded.VersionId,
        sha256: sha,
        size: object.Size,
      });
    }
    continuation = listing.IsTruncated
      ? listing.NextContinuationToken
      : undefined;
    if (listing.IsTruncated && !continuation)
      throw new Error("invalid pagination");
  } while (continuation);
  const recovery = process.argv[2];
  if (!recovery || !/^[a-f0-9]{64}$/.test(recovery))
    throw new Error("verified recovery bundle required");
  const directory = `.state/${secret("FV_ENV")}/recovery/${recovery}`;
  for (const name of (await readdir(directory)).sort()) {
    if (!/^[a-zA-Z0-9.-]+$/.test(name))
      throw new Error("unsafe recovery artifact");
    const data = await readFile(`${directory}/${name}`);
    if (data.length > 1024 * 1024)
      throw new Error("recovery artifact too large");
    const sha = createHash("sha256").update(data).digest("base64"),
      key = `${prefix}/recovery/${name}`;
    const uploaded = await dest.send(
      new PutObjectCommand({
        Bucket: secret("IMMUTABLE_BUCKET"),
        Key: key,
        Body: data,
        ContentLength: data.length,
        ChecksumSHA256: sha,
        IfNoneMatch: "*",
        ServerSideEncryption: "AES256",
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: new Date(Date.now() + 90 * 86400000),
      }),
    );
    const head = await dest.send(
      new HeadObjectCommand({
        Bucket: secret("IMMUTABLE_BUCKET"),
        Key: key,
        VersionId: uploaded.VersionId,
        ChecksumMode: "ENABLED",
      }),
    );
    if (
      head.ChecksumSHA256 !== sha ||
      head.ContentLength !== data.length ||
      head.ObjectLockMode !== "COMPLIANCE"
    )
      throw new Error("recovery offsite verification failed");
    manifest.push({
      key,
      version: uploaded.VersionId,
      sha256: sha,
      size: data.length,
    });
  }
  if (!manifest.length) throw new Error("empty backup replication");
  const body = JSON.stringify({
    version: 1,
    environment: secret("FV_ENV"),
    objects: manifest,
  });
  const signature = createHmac("sha256", secret("BACKUP_HMAC_KEY"))
    .update(body)
    .digest("hex");
  await dest.send(
    new PutObjectCommand({
      Bucket: secret("IMMUTABLE_BUCKET"),
      Key: `${prefix}/manifest.json`,
      Body: JSON.stringify({ body, signature }),
      IfNoneMatch: "*",
      ObjectLockMode: "COMPLIANCE",
      ObjectLockRetainUntilDate: new Date(Date.now() + 90 * 86400000),
    }),
  );
  console.log(
    JSON.stringify({
      event: "backup.immutable_copy.verified",
      objects: manifest.length,
      signature,
    }),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
