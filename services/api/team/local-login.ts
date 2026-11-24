import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import {
  bearer,
  denied,
  hash,
  randomToken,
} from "../../../packages/auth/index.ts";
import { applicationId } from "../../../packages/frontend-contracts/founder-village-team/index.ts";

const prefix = "fvteam_";
export async function teamActor(req: FastifyRequest, db: pg.Pool) {
  const header = req.headers.authorization;
  if (
    process.env.FV_ENV === "local" &&
    header?.startsWith("Bearer " + prefix)
  ) {
    const token = header.slice(7);
    if (!/^fvteam_[a-zA-Z0-9_-]{43}$/.test(token)) denied();
    const { rows } = await db.query<{ actor: string | null }>(
      "SELECT app.team_session_actor($1) AS actor",
      [hash(token)],
    );
    return rows[0]?.actor ?? denied();
  }
  return (await bearer(req)).actor;
}

export function registerLocalTeamLogin(app: FastifyInstance, db: pg.Pool) {
  if (process.env.FV_ENV !== "local") return;
  app.post("/team/local-login", async (req, reply) => {
    if (req.headers["x-application-id"] !== applicationId) denied(403);
    const { code } = z
      .object({ code: z.string().regex(/^[a-zA-Z0-9_-]{43}$/) })
      .strict()
      .parse(req.body);
    const token = prefix + randomToken();
    const { rows } = await db.query<{ allowed: boolean }>(
      "SELECT app.exchange_team_code($1,$2) AS allowed",
      [hash(code), hash(token)],
    );
    if (!rows[0]?.allowed) denied();
    reply.header("cache-control", "no-store");
    return { accessToken: token, expiresIn: 900 };
  });
}
