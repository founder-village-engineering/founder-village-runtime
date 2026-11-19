import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import {
  pool,
  secret,
  audit,
  transaction,
} from "../packages/database/index.ts";
import { applications } from "../packages/database/applications.ts";
import { hash, local } from "../packages/auth/index.ts";

export async function localAdminLink(): Promise<string> {
  if (!local())
    throw new Error(
      "CLI sign-in is local-only; remote administrators use OIDC MFA",
    );
  const roots = z
    .array(z.string())
    .min(1)
    .parse(JSON.parse(secret("ROOT_ADMIN_ACTORS")));
  const actor = roots[0]!;
  const origin = new URL(secret("ADMIN_ORIGIN"));
  if (
    origin.protocol !== "https:" ||
    origin.hostname !== "admin.fv" ||
    origin.port ||
    origin.username ||
    origin.password
  )
    throw new Error("canonical local admin HTTPS origin required");
  const token = randomBytes(32).toString("base64url");
  const db = pool("CONTROL_DATABASE_URL");
  try {
    await transaction(db, async (c) => {
      const result = await c.query<{
        actions: string[];
        applications: string[];
      }>(
        "SELECT actions,applications FROM control.administrators WHERE actor=$1 AND enabled",
        [actor],
      );
      const grants = result.rows[0];
      if (
        !grants?.actions.includes("admins.manage") ||
        !applications.every((a) => grants.applications.includes(a.id))
      )
        throw new Error(
          "enabled root administrator with all application grants required",
        );
      await c.query(
        "DELETE FROM control.local_admin_codes WHERE expires_at<=now() OR actor=$1",
        [actor],
      );
      await c.query(
        "INSERT INTO control.local_admin_codes(token_hash,actor,expires_at) VALUES($1,$2,now()+interval '5 minutes')",
        [hash(token), actor],
      );
      await audit(c, actor, "session.code.issue", "local-admin", "issued");
    });
  } finally {
    await db.end();
  }
  return `${origin.origin}/#admin-login=${token}`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const url = await localAdminLink();
  if (process.argv.includes("--json"))
    console.log(JSON.stringify({ url, expiresInSeconds: 300 }));
  else {
    console.log(
      `Single-use admin sign-in link (expires in 5 minutes):\n${url}`,
    );
    if (process.argv.includes("--open")) {
      if (process.platform !== "darwin")
        throw new Error("automatic browser opening supports macOS only");
      await promisify(execFile)("open", [url]);
    }
  }
}
