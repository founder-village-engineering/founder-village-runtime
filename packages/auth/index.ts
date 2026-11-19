import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyRequest } from "fastify";
import { secret } from "../database/index.ts";
export const environment = () => {
  const e = process.env.FV_ENV;
  if (!["local", "staging", "production"].includes(e ?? ""))
    throw new Error("FV_ENV required");
  return e!;
};
export const local = () => environment() === "local";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
export function denied(code = 401): never {
  throw Object.assign(new Error("access denied"), { statusCode: code });
}
let oidc: ReturnType<typeof createRemoteJWKSet> | undefined,
  access: ReturnType<typeof createRemoteJWKSet> | undefined;
export type Identity = {
  actor: string;
  subject: string;
  claims: Record<string, unknown>;
};
// Requesting acr_values is advisory in OIDC. Enforce the signed result too,
// including recent authentication and the authorized party for ID tokens.
export function adminAssurance(
  claims: Record<string, unknown>,
  clientId: string,
) {
  const now = Date.now() / 1000;
  if (
    !Array.isArray(claims.amr) ||
    !claims.amr.includes("mfa") ||
    claims.acr !== secret("OIDC_MFA_ACR") ||
    typeof claims.auth_time !== "number" ||
    !Number.isFinite(claims.auth_time) ||
    now - claims.auth_time > 3600 ||
    claims.auth_time - now > 5 ||
    (claims.azp !== undefined && claims.azp !== clientId) ||
    (Array.isArray(claims.aud) &&
      claims.aud.length > 1 &&
      claims.azp !== clientId)
  )
    denied(403);
}
export async function identity(
  token: string,
  admin = false,
): Promise<Identity> {
  const issuer = secret("OIDC_ISSUER"),
    audience = secret(admin && !local() ? "OIDC_CLIENT_ID" : "OIDC_AUDIENCE");
  let key;
  if (local()) {
    const value = secret("LOCAL_JWT_SECRET");
    if (value.length < 32) throw new Error("weak signing key");
    key = new TextEncoder().encode(value);
  } else {
    const url = new URL(secret("OIDC_JWKS_URL"));
    if (url.protocol !== "https:") throw new Error("HTTPS JWKS required");
    oidc ??= createRemoteJWKSet(url, {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
    });
    key = oidc;
  }
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer,
      audience,
      algorithms: local() ? ["HS256"] : ["RS256", "ES256"],
      requiredClaims: ["exp", "iat", "sub"],
      maxTokenAge: "1h",
      clockTolerance: 5,
    });
    if (!payload.sub || payload.sub.length > 200) denied();
    if (admin && !local()) adminAssurance(payload, audience);
    return {
      actor: `${issuer}|${payload.sub}`,
      subject: payload.sub,
      claims: payload,
    };
  } catch {
    denied();
  }
}
export async function bearer(req: FastifyRequest): Promise<Identity> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ") || header.length > 12000) denied();
  return identity(header.slice(7));
}
export async function accessGate(req: FastifyRequest): Promise<void> {
  if (local()) return;
  const team = secret("ACCESS_TEAM");
  if (!/^[a-z0-9-]+$/.test(team)) throw new Error("invalid Access team");
  const issuer = `https://${team}.cloudflareaccess.com`;
  access ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    timeoutDuration: 5000,
  });
  const assertion = req.headers["cf-access-jwt-assertion"];
  if (typeof assertion !== "string") denied();
  try {
    await jwtVerify(assertion, access, {
      issuer,
      audience: secret("ACCESS_AUD"),
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub"],
    });
  } catch {
    denied();
  }
}
export async function localToken(subject: string): Promise<string> {
  if (!local()) throw new Error("local identity disabled");
  return new SignJWT({ amr: ["mfa"] })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuer(secret("OIDC_ISSUER"))
    .setAudience(secret("OIDC_AUDIENCE"))
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret("LOCAL_JWT_SECRET")));
}
export function sameOrigin(req: FastifyRequest) {
  const origins = [secret("ADMIN_ORIGIN")];
  if (local()) origins.push("http://127.0.0.1:43802");
  if (
    !origins.includes(req.headers.origin ?? "") ||
    req.headers["sec-fetch-site"] === "cross-site"
  )
    denied(403);
}
export function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function verifyWebhook(
  body: Buffer,
  stamp: string,
  signature: string,
  key: string,
  now = Date.now(),
) {
  if (!/^\d{10}$/.test(stamp) || Math.abs(now / 1000 - Number(stamp)) > 300)
    return false;
  return equal(
    createHmac("sha256", key).update(`${stamp}.`).update(body).digest("hex"),
    signature,
  );
}
