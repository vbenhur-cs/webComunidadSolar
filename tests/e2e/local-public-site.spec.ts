import { expect, test, type Page } from "@playwright/test";

import { buildSitemap } from "../../src/lib/site/sitemap";

const legalPaths = [
  "/aviso-legal",
  "/cookies",
  "/politica-privacidad",
  "/terminos-y-condiciones",
] as const;

const publicPaths = [
  ...new Set([
    ...buildSitemap(new Date("2026-08-21T00:00:00.000Z")).map(
      (entry) => new URL(entry.url).pathname,
    ),
    ...legalPaths,
  ]),
].sort();

const publicSiteAuditTimeout = Math.max(300_000, publicPaths.length * 10_000);

type RuntimeIssue = {
  path: string;
  kind: string;
  detail: string;
};

async function loadVisibleImages(page: Page): Promise<void> {
  const images = page.locator("img:visible");
  const imageCount = await images.count();

  for (let index = 0; index < imageCount; index += 1) {
    const image = images.nth(index);
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(
        () =>
          image.evaluate((element) => {
            const candidate = element as HTMLImageElement;
            return candidate.complete && candidate.naturalWidth > 0;
          }),
        {
          message:
            "La imagen visible debe terminar de cargar tras entrar en el viewport",
          timeout: 5_000,
        },
      )
      .toBe(true);
  }
}

async function hydrateVisibleIslands(page: Page): Promise<void> {
  while (true) {
    const pendingCount = await page.locator("astro-island[ssr]").count();
    if (pendingCount === 0) return;

    const visited = await page.evaluate(() => {
      const island = document.querySelector("astro-island[ssr]");
      if (!island) return false;
      island.scrollIntoView({ block: "center" });
      return true;
    });
    if (!visited) continue;

    await expect
      .poll(() => page.locator("astro-island[ssr]").count(), {
        message: "La isla visible debe hidratarse tras entrar en el viewport",
        timeout: 5_000,
      })
      .toBeLessThan(pendingCount);
  }
}

test("every public page runs from local source without failed resources or browser errors", async ({
  page,
  request,
}) => {
  test.setTimeout(publicSiteAuditTimeout);

  const issues: RuntimeIssue[] = [];
  const checkedImages = new Set<string>();
  let activePath = "/";

  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => {
    issues.push({
      path: activePath,
      kind: "external-request",
      detail: route.request().url(),
    });
    return route.abort();
  });

  for (const path of publicPaths) {
    activePath = path;
    const consoleErrors: string[] = [];
    const failedLocalResources: string[] = [];
    const onConsole = (message: { type(): string; text(): string }) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    };
    const onPageError = (error: Error) => consoleErrors.push(error.message);
    const onResponse = (response: {
      status(): number;
      url(): string;
      request(): { resourceType(): string };
    }) => {
      const url = new URL(response.url());
      if (
        (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
        response.status() >= 400
      ) {
        failedLocalResources.push(
          `${response.status()} ${response.request().resourceType()} ${url.pathname}`,
        );
      }
    };
    const onRequestFailed = (failedRequest: {
      url(): string;
      failure(): { errorText: string } | null;
    }) => {
      const url = new URL(failedRequest.url());
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
        failedLocalResources.push(
          `failed ${url.pathname}: ${failedRequest.failure()?.errorText ?? "unknown"}`,
        );
      }
    };

    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("response", onResponse);
    page.on("requestfailed", onRequestFailed);

    try {
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      if (response?.status() !== 200) {
        issues.push({
          path,
          kind: "document-status",
          detail: String(response?.status() ?? "no response"),
        });
        continue;
      }

      await loadVisibleImages(page);
      await hydrateVisibleIslands(page);

      const structure = await page.evaluate(() => ({
        title: document.title.trim(),
        mainCount: document.querySelectorAll("main").length,
        headingCount: document.querySelectorAll("h1").length,
        pendingIslands: [...document.querySelectorAll("astro-island[ssr]")].map(
          (island) =>
            island.getAttribute("component-export") ??
            island.getAttribute("component-url") ??
            "unknown",
        ),
        brokenVisibleImages: [...document.images]
          .filter((image) => {
            const bounds = image.getBoundingClientRect();
            const style = getComputedStyle(image);
            const visible =
              bounds.width > 0 &&
              bounds.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden";
            return visible && (!image.complete || image.naturalWidth === 0);
          })
          .map((image) => image.getAttribute("src") ?? "missing-src"),
        localImageUrls: [...document.images]
          .map((image) => image.getAttribute("src"))
          .filter((source): source is string => Boolean(source))
          .map((source) => new URL(source, document.baseURI).href)
          .filter((url) => new URL(url).origin === location.origin),
      }));

      if (!structure.title) {
        issues.push({ path, kind: "document-title", detail: "empty" });
      }
      if (structure.mainCount !== 1) {
        issues.push({
          path,
          kind: "main-landmark",
          detail: String(structure.mainCount),
        });
      }
      if (structure.headingCount !== 1) {
        issues.push({
          path,
          kind: "primary-heading",
          detail: String(structure.headingCount),
        });
      }
      for (const island of structure.pendingIslands) {
        issues.push({ path, kind: "pending-island", detail: island });
      }
      for (const image of structure.brokenVisibleImages) {
        issues.push({ path, kind: "broken-visible-image", detail: image });
      }

      for (const imageUrl of new Set(structure.localImageUrls)) {
        if (checkedImages.has(imageUrl)) continue;
        checkedImages.add(imageUrl);
        const imageResponse = await request.get(imageUrl);
        if (
          imageResponse.status() !== 200 ||
          !imageResponse.headers()["content-type"]?.startsWith("image/")
        ) {
          issues.push({
            path,
            kind: "image-response",
            detail: `${imageResponse.status()} ${imageUrl}`,
          });
        }
      }

      for (const error of consoleErrors) {
        issues.push({ path, kind: "browser-console", detail: error });
      }
      for (const failure of failedLocalResources) {
        issues.push({ path, kind: "local-resource", detail: failure });
      }
    } catch (error) {
      issues.push({
        path,
        kind: "audit-exception",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
    }
  }

  expect(issues, JSON.stringify(issues, null, 2)).toEqual([]);
});

test("the Manganáfer interest form persists through the local D1 binding", async ({
  page,
}) => {
  await page.goto("/comunidades-energeticas/manganafer");
  await expect(
    page.locator(
      'astro-island[component-export="ManganaferInterestForm"]:not([ssr])',
    ),
  ).toHaveCount(1);

  const form = page.locator(".manganafer-form-card form");
  await form.locator("[name=firstName]").fill("Prueba");
  await form.locator("[name=lastName]").fill("Local");
  await form.locator("[name=email]").fill("operativa-local@example.test");
  await form.locator("[name=phone]").fill("600000000");
  await form.locator("[name=municipality]").fill("Cartagena");
  await form.locator("[name=postalCode]").fill("30385");
  await form.locator("[name=participantProfile]").selectOption("hogar");
  await form.locator("[name=privacyAccepted]").check();
  await form.getByRole("button", { name: "Quiero formar parte" }).click();

  await expect(page.getByRole("status")).toContainText(
    "Ya formas parte de la lista de interesados.",
  );
});

test("local metadata endpoints remain available", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  const sitemap = await request.get("/sitemap.xml");

  expect(robots.status()).toBe(200);
  expect(robots.headers()["content-type"]).toContain("text/plain");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toContain("application/xml");
});
