import { test, expect } from "@playwright/test";
import { signIn } from "./sign-in.ts";

test("root administrator inspects real Hasura inside the authenticated admin panel", async ({
  page,
}, info) => {
  const deniedReads: string[] = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/hasura/") && response.status() >= 400)
      deniedReads.push(`${response.status()} ${path}`);
  });
  await signIn(page);
  await page.getByRole("button", { name: "Hasura", exact: true }).click();
  await expect(
    page.getByText(
      "Read-only inspection. Schema changes use versioned migrations.",
    ),
  ).toBeVisible();
  const frame = page.frameLocator('iframe[title="Hasura console"]');
  await expect(
    frame.getByText("app / records", { exact: true }).first(),
  ).toBeVisible({ timeout: 45000 });
  await frame.getByText("app / records", { exact: true }).first().click();
  await expect(frame.getByText("Page 1", { exact: true })).toBeVisible();
  await page.getByLabel("Application namespace").selectOption("founder-cafe");
  await expect(page.locator('iframe[title="Hasura console"]')).toHaveAttribute(
    "src",
    /\/hasura\/console\/data\/manage\/source\/founder-cafe$/,
  );
  await expect(
    frame.getByText("app / records", { exact: true }).first(),
  ).toBeVisible({ timeout: 45000 });
  await page.screenshot({
    path: `.state/qa/hasura-${info.project.name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  expect(deniedReads).toEqual([]);
  await page.getByRole("button", { name: /Sign out/ }).click();
  await expect(
    page.getByRole("heading", { name: /Your village/ }),
  ).toBeVisible();
});
