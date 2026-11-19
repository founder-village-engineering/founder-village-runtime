import { test, expect } from "@playwright/test";
import { signIn } from "./sign-in.ts";
test("named admin reviews namespaces, queues a durable operation, and signs out", async ({
  page,
}, info) => {
  await signIn(page);
  await expect(
    page.getByRole("heading", { name: "A clear view of everything." }),
  ).toBeVisible();
  if (page.url().startsWith("https://")) {
    const cookies = await page.context().cookies();
    expect(cookies.find((cookie) => cookie.name === "fv_session")?.secure).toBe(
      true,
    );
    expect(cookies.find((cookie) => cookie.name === "fv_csrf")?.secure).toBe(
      true,
    );
  }
  await page.getByRole("button", { name: "Databases", exact: true }).click();
  for (const name of [
    "founder-village",
    "founder-farm",
    "founder-cafe",
    "founder-residences",
  ])
    await expect(
      page
        .getByRole("row")
        .filter({ has: page.getByRole("cell", { name, exact: true }).first() }),
    ).toBeVisible();
  await expect(page.getByLabel("Application namespace")).toBeVisible();
  await page.getByLabel("Application namespace").selectOption("founder-cafe");
  await page.getByRole("button", { name: "Backups", exact: true }).click();
  await page
    .getByRole("button", { name: "Verify backup", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("local");
  await page.getByRole("button", { name: "Confirm operation →" }).click();
  await expect(
    page.getByRole("heading", { name: "Operation ledger" }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "backup.verify" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.screenshot({
    path: `.state/qa/admin-${info.project.name}.png`,
    fullPage: true,
  });
  // The page shell must fit the viewport; horizontally scrolling tables stay inside their panels.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  if (info.project.name === "desktop") {
    await page.getByRole("button", { name: "Sign out ↗" }).click();
    await expect(
      page.getByRole("heading", { name: /Your village/ }),
    ).toBeVisible();
  }
});
