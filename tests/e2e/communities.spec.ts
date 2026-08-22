import { expect, test } from "@playwright/test";

import { communityPages } from "../../src/content/community-data.ts";

test("the community catalogue and every published detail page are static", async ({
  page,
}) => {
  const catalogue = await page.goto("/comunidades-energeticas");

  expect(catalogue?.status()).toBe(200);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator(".communities-hero")).toHaveCount(1);

  for (const community of communityPages) {
    const response = await page.goto(
      `/comunidades-energeticas/${community.slug}`,
    );

    expect(response?.status(), community.slug).toBe(200);
    await expect(
      page.locator(
        community.kind === "network"
          ? ".community-network-detail"
          : ".community-local-detail",
      ),
    ).toHaveCount(1);
  }
});

test("the catalogue preserves the source text boundary after its scale warning", async ({
  page,
}) => {
  await page.goto("/comunidades-energeticas");

  await expect(page.locator(".community-scale-note")).toContainText(
    "No todos los proyectos están cerrados ni disponibles. Datos revisados en julio de 2026.",
  );
  expect(
    await page
      .locator(".community-scale-note")
      .evaluate((element) =>
        element.innerHTML.includes(
          "</strong> Datos revisados en julio de 2026.",
        ),
      ),
  ).toBe(true);
});

test("community details preserve the React SSR text-node boundaries", async ({
  page,
}) => {
  await page.goto("/comunidades-energeticas/villalbilla");

  await expect(
    page.locator(".community-local-installation-facts dd").filter({
      hasText: "130,075 kWp",
    }),
  ).toHaveText("130,075 kWp");
  expect(
    await page
      .locator(".community-local-installation-facts dd")
      .filter({ hasText: "130,075 kWp" })
      .evaluate((element) => element.innerHTML),
  ).toBe("130,075<!-- --> kWp");
  expect(
    await page
      .locator(".community-technical-details dd")
      .filter({ hasText: "605 W" })
      .evaluateAll((elements) => elements.map((element) => element.innerHTML)),
  ).toEqual(["605<!-- --> W", "605<!-- --> W"]);
  expect(
    await page
      .locator(".community-technical-details dd")
      .filter({ hasText: "0,4651%" })
      .evaluateAll((elements) => elements.map((element) => element.innerHTML)),
  ).toEqual(["0,4651<!-- -->%"]);

  await page.goto("/comunidades-energeticas/extremadura");
  const locationLabels = page.locator(
    ".community-network-location-card > div > span",
  );

  await expect(locationLabels).toHaveCount(10);
  const locationBoundaryHtml = await locationLabels.evaluateAll((elements) =>
    elements.map((element) => element.innerHTML),
  );
  expect(locationBoundaryHtml).toContain(
    "Badajoz<!-- --> · <!-- -->4<!-- --> <!-- -->instalaciones",
  );
  expect(
    locationBoundaryHtml.every((value) =>
      /^[^<]+<!-- --> · <!-- -->\d+<!-- --> <!-- -->instalaci(?:ón|ones)$/.test(
        value,
      ),
    ),
  ).toBe(true);

  await page.goto("/comunidades-energeticas/ontinyent");
  expect(
    await page
      .locator(".community-local-installation-facts dd")
      .filter({ hasText: "135,6 kWp" })
      .evaluate((element) => element.innerHTML),
  ).toBe("135,6<!-- --> kWp");
});

test("each community detail exposes its source hero image as social metadata", async ({
  page,
}) => {
  const community = communityPages.find(({ slug }) => slug === "villalbilla")!;

  await page.goto(`/comunidades-energeticas/${community.slug}`);

  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    `https://comunidadsolar.es${community.image}`,
  );
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute(
    "content",
    community.imageAlt,
  );
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
    "content",
    `https://comunidadsolar.es${community.image}`,
  );
});
