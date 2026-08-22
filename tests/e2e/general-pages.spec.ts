import { expect, test } from "@playwright/test";

test("operational plant form stays absent until the owner requests it", async ({
  page,
}) => {
  const response = await page.goto("/comunidades-energeticas-operativas");

  expect(response?.status()).toBe(200);

  const form = page.locator("#formulario-planta");
  await expect(form.locator("iframe")).toHaveCount(0);

  const trigger = page.locator(".operational-value-copy").getByRole("link", {
    name: "Analizar el encaje de mi planta",
    exact: true,
  });
  await expect(
    page.locator('astro-island[component-export="OperationalPlantForm"]'),
  ).not.toHaveAttribute("ssr");
  await trigger.click();

  await expect(form.locator("iframe")).toHaveCount(1);
});

test("operational plant hash intent reveals the embedded form", async ({
  page,
}) => {
  const response = await page.goto(
    "/comunidades-energeticas-operativas#formulario-planta",
  );

  expect(response?.status()).toBe(200);
  await expect(page.locator("#formulario-planta iframe")).toHaveCount(1);
});

test("keeps React's legal-note text boundaries in the static routes", async ({
  page,
}) => {
  await page.goto("/rentabiliza-tu-activo");
  expect(
    await page
      .locator(".assets-page-contact-note")
      .evaluate((element) => element.innerHTML),
  ).toContain("nuestra<!-- --> <a");

  await page.goto("/comunidades-energeticas-operativas");
  expect(
    await page
      .locator(".operational-closing-action small")
      .evaluate((element) => element.innerHTML),
  ).toContain("nuestra<!-- --> <a");
});

test("keeps the source-specific SEO metadata for the four public routes", async ({
  page,
}) => {
  const expected = [
    [
      "/soy-comunero",
      "Soy comunero | Comunidad Solar",
      "Accede a la app Comunidad Solar o entra identificado en Atención al Comunero para consultar y seguir tus solicitudes.",
    ],
    [
      "/contacto",
      "Contacto | Comunidad Solar",
      "Habla con un asesor energético si estás decidiendo o entra directamente en los canales de atención si ya eres comunero.",
    ],
    [
      "/rentabiliza-tu-activo",
      "Rentabiliza tu activo | Comunidad Solar",
      "Convierte tu cubierta o planta fotovoltaica en una comunidad energética con la gestión comercial y energética de Comunidad Solar.",
    ],
    [
      "/comunidades-energeticas-operativas",
      "Convierte tu planta en una comunidad energética operativa | Comunidad Solar",
      "Comunidad Solar aporta Helios, comercializadora, captación y operación para conectar plantas fotovoltaicas construidas con hogares y empresas de proximidad.",
    ],
  ] as const;

  for (const [path, title, description] of expected) {
    await page.goto(path);
    await expect(page).toHaveTitle(title);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      description,
    );
  }
});
