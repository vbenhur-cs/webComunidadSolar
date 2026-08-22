import { expect, test } from "@playwright/test";

import { blogPosts } from "../../src/content/blog-data.ts";
import { remoteProjects } from "../../src/content/remote-project-data.ts";

test("every remote project and post has a generated public path", async ({
  page,
}) => {
  expect(remoteProjects).toHaveLength(3);
  expect(blogPosts).toHaveLength(19);

  for (const project of remoteProjects) {
    const response = await page.goto(`/autoconsumo-remoto/${project.slug}`);

    expect(response?.status(), project.slug).toBe(200);
  }

  for (const post of blogPosts) {
    const response = await page.goto(`/blog/${post.slug}`);

    expect(response?.status(), post.slug).toBe(200);
  }
});

test("blog filter exposes every post before client filtering", async ({
  page,
}) => {
  const response = await page.goto("/blog");

  expect(response?.status()).toBe(200);
  await expect(page.locator("article[data-blog-post]")).toHaveCount(19);

  // The archive deliberately hydrates on visibility. Scroll the control into
  // view and wait for Astro's observable hydration completion before asserting
  // its interactive behavior, just as a visitor does before clicking it.
  const blogFilter = page.locator(
    'astro-island[component-export="BlogFilter"]',
  );
  await page.locator(".blog-filters").scrollIntoViewIfNeeded();
  await expect
    .poll(() => blogFilter.evaluate((element) => !element.hasAttribute("ssr")))
    .toBe(true);

  await page.getByRole("button", { name: "Comunidad", exact: true }).click();
  await expect(page.locator("article[data-blog-post]:visible")).not.toHaveCount(
    19,
  );
});

test("blog manifesto preserves the dynamic React SSR text boundary", async ({
  page,
}) => {
  await page.goto("/blog");

  expect(
    await page
      .locator(".blog-manifesto-facts strong")
      .nth(1)
      .evaluate((element) => element.innerHTML),
  ).toBe("19<!-- --> historias");
});

test("remote and about videos defer their iframe until visitor intent", async ({
  page,
}) => {
  await page.goto("/autoconsumo-remoto");

  const remoteVideo = page.locator("[data-remote-hero-video]");
  await expect(remoteVideo.locator("iframe")).toHaveCount(0);
  await remoteVideo.getByRole("button").click();
  await expect(remoteVideo.locator("iframe")).toHaveCount(1);

  await page.goto("/nosotros");

  const aboutVideo = page.locator("[data-about-video]");
  await expect(aboutVideo.locator("iframe")).toHaveCount(0);
  await aboutVideo.getByRole("button", { name: /ver hay decisiones/i }).click();
  await expect(page.locator("#about-legacy-video-dialog iframe")).toHaveCount(
    1,
  );
});

test("remote related projects preserve React SSR text-node boundaries", async ({
  page,
}) => {
  await page.goto("/autoconsumo-remoto/torrontera");
  expect(
    await page
      .locator(".related-community-card p")
      .evaluateAll((elements) => elements.map((element) => element.innerHTML)),
  ).toEqual([
    "En funcionamiento<!-- --> · <!-- -->Completo",
    "En funcionamiento<!-- --> · <!-- -->Completo",
  ]);

  await page.goto("/autoconsumo-remoto/liguerzana");
  expect(
    await page
      .locator(".related-community-card p")
      .evaluateAll((elements) => elements.map((element) => element.innerHTML)),
  ).toEqual([
    "En funcionamiento<!-- --> · <!-- -->Disponible",
    "En funcionamiento<!-- --> · <!-- -->Completo",
  ]);
});
