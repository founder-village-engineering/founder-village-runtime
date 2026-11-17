import { test, expect, type Locator } from "@playwright/test";

test("text fields dismiss on an outside tap across every form screen", async ({
  page,
}, info) => {
  const tap = (target: Locator, position?: { x: number; y: number }) =>
    info.project.use.hasTouch
      ? target.tap({ position })
      : target.click({ position });

  await page.goto("/");
  await page.getByRole("button", { name: /Open local console/ }).click();
  await expect(
    page.getByRole("heading", { name: "A clear view of everything." }),
  ).toBeVisible();

  for (const screen of ["Deployments", "Operations", "Domains", "Access"]) {
    await tap(
      page.getByRole("button", { name: new RegExp(`^${screen}(?:\\s|$)`) }),
    );
    const fields = page.locator('input:not([type="checkbox"])');
    expect(await fields.count()).toBeGreaterThan(0);
    for (const field of await fields.all()) {
      const value =
        (await field.getAttribute("type")) === "number"
          ? "120"
          : "keyboard dismissal";
      await field.fill(value);
      await tap(field);
      await expect(field).toBeFocused();
      await tap(page.getByRole("heading", { name: screen, exact: true }));
      await expect(field).not.toBeFocused();
      await expect(field).toHaveValue(value);
    }
  }

  await tap(page.getByRole("button", { name: "Domains", exact: true }));
  const name = page.getByRole("textbox", { name: "Record name", exact: true });
  const value = page.getByRole("textbox", { name: "Value", exact: true });
  const outside = page.getByRole("heading", { name: "Domains", exact: true });
  const pointer = {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: 20,
    clientY: 20,
  };
  // Exercise dismissal without the browser's automatic mouse blur or click.
  // A cancelled scroll and a drag must keep the current editing session.
  await tap(name);
  await outside.dispatchEvent("pointerdown", pointer);
  await outside.dispatchEvent("pointercancel", pointer);
  await outside.dispatchEvent("pointerup", pointer);
  await expect(name).toBeFocused();
  await outside.dispatchEvent("pointerdown", pointer);
  await outside.dispatchEvent("pointerup", { ...pointer, clientY: 100 });
  await expect(name).toBeFocused();
  await outside.dispatchEvent("pointerdown", pointer);
  await outside.dispatchEvent("pointerup", pointer);
  await expect(name).not.toBeFocused();

  await tap(name);
  await tap(value);
  await expect(value).toBeFocused();
  // Tap the label text, outside the input itself.
  await tap(page.locator("label").filter({ has: name }), { x: 8, y: 5 });
  await expect(name).toBeFocused();
  await tap(page.getByLabel("Proxy through Cloudflare"));
  await expect(page.getByLabel("Proxy through Cloudflare")).toBeChecked();
  await expect(name).not.toBeFocused();

  await tap(name);
  await page.keyboard.press("Escape");
  await expect(name).not.toBeFocused();

  await tap(page.getByRole("button", { name: "Deployments", exact: true }));
  const release = page.getByLabel("Release ID");
  await release.fill("a".repeat(64));
  await tap(page.getByRole("button", { name: "Review deployment →" }));
  await expect(page.getByRole("dialog")).toContainText("deploy.release");
  await expect(page.getByRole("dialog")).toContainText("a".repeat(64));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
