import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { local } from "../../packages/auth/index.ts";
import { pool, secret, transaction } from "../../packages/database/index.ts";
import { applicationId } from "../../packages/frontend-contracts/founder-village-team/index.ts";
import { issueLocalTeamCode } from "../../scripts/team-login.ts";
import { sealTeamPayload } from "../../services/api/team/crypto.ts";
import { api } from "../../services/api/app.ts";

const origin = "https://team.fv";
const apiOrigin = "https://api.fv";
const dist = resolve(".state/team-browser-dist");
const testOrigin = "https://api.example.test";

async function serveArtifact(context: BrowserContext, backend: string) {
  const headersFile = await readFile(resolve(dist, "_headers"), "utf8");
  const headers = Object.fromEntries(
    headersFile
      .split("\n\n")[0]!
      .split("\n")
      .slice(1)
      .map((line) => {
        const split = line.indexOf(":");
        return [
          line.slice(0, split).trim(),
          line
            .slice(split + 1)
            .trim()
            .replace(testOrigin, apiOrigin),
        ];
      }),
  );
  expect(headers["Content-Security-Policy"]).toContain("style-src 'self'");
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === apiOrigin) {
      const response = await route.fetch({
        url: backend + url.pathname + url.search,
      });
      return route.fulfill({ response });
    }
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/runtime-config.js") {
      const config = await readFile(resolve(dist, "runtime-config.js"), "utf8");
      expect(config).toContain(testOrigin);
      return route.fulfill({
        body: config.replace(testOrigin, apiOrigin),
        contentType: "text/javascript",
      });
    }
    const file = resolve(dist, "." + url.pathname);
    if (file === dist)
      return route.fulfill({ path: resolve(dist, "index.html"), headers });
    if (!file.startsWith(dist + "/")) return route.abort();
    return route.fulfill({ path: file });
  });
}

async function signIn(page: Page, subject: string) {
  const code = await issueLocalTeamCode(subject);
  // Prime the local link inside this disposable context to keep the code out of test step URLs.
  await page.goto(origin);
  await page.evaluate(
    (value) => history.replaceState({}, "", "#team-login=" + value),
    code,
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "New conversation" }),
  ).toBeVisible();
  const replay = await page.evaluate(
    async ({ code, apiOrigin, applicationId }) => {
      const result = await fetch(apiOrigin + "/v1/team/local-login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-application-id": applicationId,
        },
        body: JSON.stringify({ code }),
      });
      return result.status;
    },
    { code, apiOrigin, applicationId },
  );
  expect(replay).toBe(401);
}

test("local members create a bot and retain their own private conversation after reload", async ({
  page,
  context,
}, testInfo) => {
  process.loadEnvFile(".state/local.env");
  if (
    !local() ||
    ![
      "FOUNDER_VILLAGE_TEAM_DATABASE_URL",
      "MIGRATION_FOUNDER_VILLAGE_TEAM_DATABASE_URL",
    ].every((key) =>
      ["127.0.0.1", "localhost"].includes(new URL(secret(key)).hostname),
    )
  )
    throw new Error("An isolated local Team database is required");
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const db = pool("FOUNDER_VILLAGE_TEAM_DATABASE_URL"),
    owner = pool("MIGRATION_FOUNDER_VILLAGE_TEAM_DATABASE_URL");
  const tenantId = randomUUID(),
    alice = randomUUID(),
    bob = randomUUID(),
    actors = [alice, bob].map((s) => secret("OIDC_ISSUER") + "|" + s);
  const app = await api({ [applicationId]: db });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  page.on("console", (message) => {
    if (message.text().startsWith("CSP violation: "))
      errors.push(message.text());
  });
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error("CSP violation: " + event.effectiveDirective);
    }),
  );
  try {
    await transaction(owner, async (c) => {
      await c.query(
        "INSERT INTO app.tenants(id,name) VALUES($1,'Synthetic browser team')",
        [tenantId],
      );
      await c.query(
        "INSERT INTO app.memberships(tenant_id,actor) SELECT $1,unnest($2::text[])",
        [tenantId, actors],
      );
    });
    await serveArtifact(
      context,
      await app.listen({ host: "127.0.0.1", port: 0 }),
    );
    await signIn(page, alice);
    if (testInfo.project.name === "mobile")
      await page.getByRole("button", { name: "Workspace menu" }).click();
    await page.getByRole("button", { name: /^Team bots/ }).click();
    await page.getByRole("button", { name: "Create bot" }).click();
    await page.getByLabel("Bot name").fill("Fixture guide");
    await page.getByLabel("Description").fill("A synthetic browser fixture");
    await page
      .getByLabel("Instructions")
      .fill("Keep a synthetic field notebook.");
    await page.getByRole("button", { name: "Save bot" }).click();
    await expect(
      page.getByRole("heading", { name: "Fixture guide" }),
    ).toBeVisible();
    expect(
      await page
        .locator("link#react-native-stylesheet")
        .evaluate(
          (element) => (element as HTMLLinkElement).sheet?.cssRules.length ?? 0,
        ),
    ).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Configure" }).click();
    await expect(page.getByLabel("Instructions")).toHaveValue(
      "Keep a synthetic field notebook.",
    );
    await page
      .getByRole("button", { name: /Team bots/ })
      .last()
      .click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByLabel("Conversation title").fill("Field notes");
    await page.getByRole("button", { name: "Start conversation" }).click();
    await page
      .getByLabel("Message", { exact: true })
      .fill("First field observation.");
    await page.getByRole("button", { name: "Save message" }).click();
    await expect(page.getByRole("log")).toContainText(
      "First field observation.",
    );
    const thread = new URL(page.url()).hash;
    expect(thread).toMatch(/^#[a-f0-9-]{36}$/);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Field notes" }),
    ).toBeVisible();
    await expect(page.getByRole("log")).toContainText(
      "First field observation.",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    // Imported message bodies may be larger than the shared JSON response limit.
    const imported = randomUUID();
    const marker = "The next portion of this synthetic message.";
    const longContent = "x".repeat(64000) + marker + "\u0001".repeat(180000);
    await owner.query(
      "INSERT INTO app.team_messages(tenant_id,conversation_id,id,position,role,payload) VALUES($1,$2,$3,2,'tool',$4)",
      [
        tenantId,
        thread.slice(1),
        imported,
        sealTeamPayload(tenantId, "message", imported, {
          content: longContent,
        }),
      ],
    );
    let chunkRequests = 0;
    page.on("request", (req) => {
      if (new URL(req.url()).pathname.endsWith("/content")) chunkRequests++;
    });
    await page.reload();
    const loadMore = page.getByRole("button", { name: "Load more text" });
    await expect(loadMore).toBeVisible();
    expect(chunkRequests).toBe(0);
    const history = page.getByRole("log");
    await expect(history).not.toContainText(marker);
    await loadMore.click();
    await expect(history).toContainText(marker);
    await expect(loadMore).toBeFocused();
    expect(chunkRequests).toBe(1);
    await page.getByRole("button", { name: "Older messages" }).click();
    await expect(history).toContainText("First field observation.");
    await expect(history).not.toContainText(marker);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(
      page.getByRole("heading", { name: "Team workspace" }),
    ).toBeVisible();
    await signIn(page, bob);
    await page.goto(origin + "/" + thread);
    await page.reload();
    await expect(
      page.getByText("You no longer have access to this item."),
    ).toBeVisible();
    await expect(page.getByText("First field observation.")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    try {
      await transaction(owner, async (c) => {
        await c.query(
          "DELETE FROM app.team_local_signins WHERE actor=ANY($1)",
          [actors],
        );
        await c.query("DELETE FROM app.memberships WHERE tenant_id=$1", [
          tenantId,
        ]);
      });
    } finally {
      await Promise.all([db.end(), owner.end()]);
    }
  }
});
