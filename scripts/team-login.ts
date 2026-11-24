import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { hash, local, randomToken } from "../packages/auth/index.ts";
import { pool, secret, transaction } from "../packages/database/index.ts";

export async function issueLocalTeamCode(subject: string) {
  if (!local() || !subject || subject.length > 200 || /[\r\n]/.test(subject))
    throw new Error("An enrolled local Team subject is required.");
  const db = pool("MIGRATION_FOUNDER_VILLAGE_TEAM_DATABASE_URL");
  const actor = secret("OIDC_ISSUER") + "|" + subject;
  const code = randomToken();
  try {
    await transaction(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        actor,
      ]);
      const enabled = await c.query(
        "SELECT 1 FROM app.memberships WHERE actor=$1 AND enabled LIMIT 1",
        [actor],
      );
      if (!enabled.rowCount)
        throw new Error("An enrolled local Team subject is required.");
      await c.query(
        "DELETE FROM app.team_local_signins WHERE (actor=$1 AND session_hash IS NULL) OR coalesce(session_expires_at,code_expires_at)<=now()",
        [actor],
      );
      await c.query(
        "INSERT INTO app.team_local_signins(code_hash,actor,code_expires_at) VALUES($1,$2,now()+interval '5 minutes')",
        [hash(code), actor],
      );
    });
    return code;
  } finally {
    await db.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [subject, ...extra] = process.argv.slice(2);
  if (!subject || extra.length || process.platform !== "darwin")
    throw new Error(
      "Usage on macOS: npm run team:login -- <enrolled-local-subject>",
    );
  try {
    const code = await issueLocalTeamCode(subject);
    await promisify(execFile)("open", ["https://team.fv/#team-login=" + code]);
    console.log("Opened the five-minute Team sign-in link.");
  } catch {
    console.error(
      "Could not open a Team sign-in link. Check the local stack and the subject’s active Team membership.",
    );
    process.exitCode = 1;
  }
}
