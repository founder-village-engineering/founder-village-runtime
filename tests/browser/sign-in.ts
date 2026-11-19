import { expect, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function signIn(page: Page) {
  await page.goto("/");
  const status = (await page.evaluate(async () =>
    (await fetch("/auth/status")).json(),
  )) as {
    local: boolean;
    fixtureLogin: boolean;
  };
  if (status.fixtureLogin) {
    await page.getByRole("button", { name: /Open local console/ }).click();
  } else {
    if (!status.local)
      throw new Error(
        "Live OIDC/MFA sign-in requires a separately authorized provider exercise",
      );
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--env-file=.state/local.env",
      "--import",
      "tsx",
      "scripts/admin-login.ts",
      "--json",
    ]);
    const { url } = JSON.parse(stdout) as { url: string };
    const code = new URLSearchParams(new URL(url).hash.slice(1)).get(
      "admin-login",
    )!;
    await page.getByLabel("One-time sign-in code").fill(code);
    await page.getByRole("button", { name: "Sign in securely ↗" }).click();
  }
  await expect(
    page.getByRole("heading", { name: "A clear view of everything." }),
  ).toBeVisible();
}
