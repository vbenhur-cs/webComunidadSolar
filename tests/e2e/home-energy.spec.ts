import { expect, test } from "@playwright/test";

test("commercializer keeps the static bill example without a page-wide React root", async ({
  page,
}) => {
  await page.goto("/comercializadora-y-tarifas");

  await expect(page.locator('[data-bill-example="true"]')).toHaveCount(1);
  await expect(page.locator('[data-bill-simulator="true"]')).toHaveCount(0);
  await expect(page.locator('input[type="range"]')).toHaveCount(0);
  await expect(page.locator("main astro-island")).toHaveCount(0);
});
