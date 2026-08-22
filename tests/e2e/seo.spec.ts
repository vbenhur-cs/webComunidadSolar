import { expect, test } from "@playwright/test";

const legalDocuments = [
  [
    "/politica-privacidad",
    "Política de privacidad | Comunidad Solar",
    "noindex, follow",
  ],
  ["/cookies", "Política de cookies | Comunidad Solar", "noindex, nofollow"],
  ["/aviso-legal", "Aviso legal | Comunidad Solar", "noindex, nofollow"],
  [
    "/terminos-y-condiciones",
    "Términos y condiciones | Comunidad Solar",
    "noindex, nofollow",
  ],
] as const;

test("renders the four legal documents with their source SEO policy", async ({
  page,
}) => {
  for (const [path, title, robots] of legalDocuments) {
    const response = await page.goto(path);

    expect(response?.status(), path).toBe(200);
    await expect(page).toHaveTitle(title);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      robots,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
    await expect(page.locator(".legal-document-content")).toBeVisible();
  }
});

test("serves robots and the deterministic public sitemap", async ({ page }) => {
  const robots = await page.request.get("/robots.txt");
  const sitemap = await page.request.get("/sitemap.xml");
  const xml = await sitemap.text();

  expect(robots.status()).toBe(200);
  expect(robots.headers()["content-type"]).toContain("text/plain");
  await expect(robots.text()).resolves.toContain("User-Agent: *");
  await expect(robots.text()).resolves.toContain("Disallow: /");
  await expect(robots.text()).resolves.toContain(
    "Sitemap: https://comunidadsolar.es/sitemap.xml",
  );
  expect(sitemap.status()).toBe(200);
  expect(xml.match(/<loc>/g)).toHaveLength(59);
  expect(xml).toContain(
    "https://comunidadsolar.es/comunidades-energeticas/manganafer",
  );
  expect(xml).not.toContain("https://comunidadsolar.es/politica-privacidad");
});

test("keeps the source Not Found response for an unknown public path", async ({
  page,
}) => {
  const response = await page.goto("/__astro-parity-missing-route__");

  expect(response?.status()).toBe(404);
  await expect(page.locator("body")).toContainText("Not Found");
});

test("keeps a local community next action as emitted machine semantics", async ({
  page,
}) => {
  const response = await page.goto(
    "/comunidades-energeticas/villaverde-getafe",
  );

  expect(response?.status()).toBe(200);
  await expect(page.locator("main.community-local-detail")).toHaveAttribute(
    "data-community-next-action",
    "Completar la legalización de los coeficientes de reparto",
  );
});
