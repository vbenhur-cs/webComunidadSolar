import { expect, test } from "@playwright/test";

test("coverage finder keeps the compact source journey on the home page", async ({
  page,
}) => {
  await page.goto("/");
  const finder = page.locator("#cobertura");
  const coverageLink = finder.getByRole("link", {
    name: /Comprobar mi cobertura/i,
  });

  await expect(
    finder.getByRole("heading", {
      name: "¿Hay una comunidad energética cerca de ti?",
    }),
  ).toBeVisible();
  await expect(finder.getByText("Tu dirección", { exact: true })).toBeVisible();
  await expect(finder.getByText("Tu factura", { exact: true })).toBeVisible();
  await expect(finder.getByText("Tu propuesta", { exact: true })).toBeVisible();
  await expect(coverageLink).toHaveAttribute(
    "href",
    "https://calculadoraenergetica.comunidadsolar.es",
  );
  await coverageLink.focus();
  await expect(coverageLink).toBeFocused();
});
