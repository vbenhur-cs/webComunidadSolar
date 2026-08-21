import { expect, test } from "@playwright/test";

test("header and consent retain keyboard behavior", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Soluciones" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#solutions-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#solutions-panel")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Tú decides qué medimos." }),
  ).toBeVisible();
});
