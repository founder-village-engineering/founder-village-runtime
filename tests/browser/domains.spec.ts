import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in.ts";

test("Domains lists configured subdomains and their backing services", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "Domains", exact: true }).click();

  const routes = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Configured subdomains" }),
  });
  await expect(
    routes.getByRole("row").filter({ hasText: "api-dev.fv" }),
  ).toContainText("api");
  await expect(
    routes.getByRole("row").filter({ hasText: "admin.fv" }),
  ).toContainText("admin-api");
  await expect(routes.getByText(/routes$/)).toHaveText(/^[1-9]\d* routes$/);
});
