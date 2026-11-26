import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { BootstrapError } from "./workstation.ts";

const forms = {
  hetzner: { label: "Hetzner project token", action: "Enroll token" },
  cloudflare: {
    label: "Temporary Cloudflare issuer token",
    action: "Issue four scoped grants",
  },
} as const;

export function browserToken(
  kind: keyof typeof forms,
  ready = (url: string) =>
    console.log("Open the one-use enrollment form at " + url),
): Promise<string> {
  const { label, action } = forms[kind];
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(32).toString("base64url");
    let host = "",
      used = false;
    const server = createServer(
      { requestTimeout: 10_000, headersTimeout: 10_000 },
      async (req, res) => {
        const origin = "http://" + host;
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Connection", "close");
        res.setHeader(
          "Content-Security-Policy",
          `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
        );
        if (req.headers.host !== host || used) {
          res.writeHead(403).end();
          return;
        }
        if (req.method === "GET" && req.url === "/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Founder Village credential enrollment</title>
<h1>${action}</h1>
<form autocomplete="off"><label>${label} <input id="token" required type="password" maxlength="2048" autocomplete="off"></label>
<button>${action}</button></form><p role="status"></p>
<script nonce="${nonce}">
const form = document.querySelector("form"), input = document.querySelector("input"), status = document.querySelector("[role=status]");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submission = fetch("/enroll", {method:"POST", credentials:"omit", cache:"no-store", redirect:"error", headers:{"Content-Type":"text/plain","X-FV-CSRF":"${nonce}"}, body:input.value});
  input.value = ""; form.remove();
  try { if (!(await submission).ok) throw new Error(); status.textContent = "Token received. Check the release terminal for the verification result."; }
  catch { status.textContent = "Submission failed. Restart enrollment in the release terminal."; }
});
</script></html>`);
          return;
        }
        if (
          req.method !== "POST" ||
          req.url !== "/enroll" ||
          req.headers.origin !== origin ||
          req.headers["x-fv-csrf"] !== nonce ||
          req.headers["content-type"] !== "text/plain" ||
          !/^[1-9]\d{0,3}$/.test(req.headers["content-length"] ?? "") ||
          Number(req.headers["content-length"]) > 2048
        ) {
          res.writeHead(403).end();
          return;
        }
        used = true;
        try {
          let token = "";
          for await (const chunk of req) token += chunk.toString("utf8");
          if (!/^[!-~]{1,2048}$/.test(token)) throw new Error();
          res.writeHead(204).end();
          resolve(token);
        } catch {
          res.writeHead(400).end();
          reject(new BootstrapError("Invalid private browser submission."));
        } finally {
          clearTimeout(expiry);
          server.close();
        }
      },
    );
    const expiry = setTimeout(() => {
      used = true;
      server.close();
      server.closeAllConnections();
      reject(
        new BootstrapError("The local credential enrollment form expired."),
      );
    }, 180_000);
    server.once("error", () => {
      clearTimeout(expiry);
      reject(
        new BootstrapError(
          "Could not open the local credential enrollment form.",
        ),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return;
      host = "127.0.0.1:" + address.port;
      ready("http://" + host + "/");
    });
  });
}
