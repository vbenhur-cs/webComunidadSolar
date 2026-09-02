import { expect, test } from "@playwright/test";

test("local dev serves public images instead of routing them through Astro", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const response = await page.goto("/");
  const hero = page.getByRole("img", {
    name: /Escena conceptual de un pueblo español/i,
  });
  const logoResponse = await page.request.get("/comunidad-solar-logo.svg");

  expect(response?.status()).toBe(200);
  expect(logoResponse.status()).toBe(200);
  expect(logoResponse.headers()["content-type"]).toContain("image/svg+xml");
  await expect(hero).toBeVisible();
  expect(
    await hero.evaluate((image) => (image as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);

  const imageSources = await page
    .locator("img[src]")
    .evaluateAll((images) =>
      [...new Set(images.map((image) => image.getAttribute("src")))].filter(
        (source): source is string => Boolean(source),
      ),
    );
  const imageResponses = await Promise.all(
    imageSources.map((source) => page.request.get(source)),
  );

  for (const imageResponse of imageResponses) {
    expect(imageResponse.status(), imageResponse.url()).toBe(200);
    expect(
      imageResponse.headers()["content-type"],
      imageResponse.url(),
    ).toMatch(/^image\//);
  }

  await page.evaluate(async () => {
    document.documentElement.style.scrollBehavior = "auto";
    for (let y = 0; y < document.documentElement.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  });
  await expect
    .poll(() =>
      page
        .locator("img")
        .evaluateAll((images) =>
          images
            .filter(
              (image) =>
                !(image as HTMLImageElement).complete ||
                (image as HTMLImageElement).naturalWidth === 0,
            )
            .map((image) => image.getAttribute("src")),
        ),
    )
    .toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("local dev hydrates the Soluciones menu", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.locator('astro-island[component-url*="HeaderIsland"]:not([ssr])'),
  ).toHaveCount(1);
  const trigger = page.getByRole("button", { name: "Soluciones" });

  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.hover();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.locator(".brand").hover();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#solutions-panel")).toBeVisible();
  await page.locator(".brand").hover();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#solutions-panel")).toBeHidden();
});

test("local dev hydrates the mobile navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Rechazar analítica" }).click();
  await expect(
    page.locator('astro-island[component-url*="HeaderIsland"]:not([ssr])'),
  ).toHaveCount(1);
  const trigger = page.locator(".menu-button");

  await expect(trigger).toHaveAttribute("aria-label", "Abrir menú");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#mobile-menu")).toBeVisible();
  await expect(
    page.locator("#mobile-menu").getByRole("link", {
      name: "Comunidades energéticas",
    }),
  ).toBeVisible();
  await page
    .locator("#mobile-menu")
    .getByRole("link", { name: "Comunidades energéticas" })
    .click();
  await expect(page).toHaveURL(/\/comunidades-energeticas$/);
});

test("local dev retains legacy redirects before Astro pages", async ({
  request,
}) => {
  const response = await request.get("/mision?utm_source=local", {
    maxRedirects: 0,
  });

  expect(response.status()).toBe(308);
  const location = new URL(response.headers().location);
  expect(`${location.pathname}${location.search}${location.hash}`).toBe(
    "/nosotros?utm_source=local#mision",
  );
});
