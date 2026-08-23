import assert from "node:assert/strict";

import { expect, test } from "@playwright/test";

import {
  executiveSummary,
  financialMetrics,
  milestoneAgenda,
  partnerUpdate,
  publishedMaterials,
  roadmapPhases,
} from "../../src/content/partner-data.ts";
import { closePreviewPool, requestPreview } from "../helpers/preview-pool.ts";

const allowedEmail = "socio-e2e@example.test";
const partnerMarkers = [
  financialMetrics[0].value,
  executiveSummary[0].title,
  partnerUpdate.edition,
  publishedMaterials[0].title,
];

const privateRoutes = [
  {
    path: "/socios",
    allowlistKey: "SOCIOS_ALLOWED_EMAILS",
    allowedSelector: "main.partner-page",
  },
  {
    path: "/guia-equipo",
    allowlistKey: "TEAM_ALLOWED_EMAILS",
    allowedSelector: "main.team-guide-page",
  },
] as const;

function identityHeaders(email: string): HeadersInit {
  return {
    "oai-authenticated-user-email": email,
    "oai-authenticated-user-full-name": "Socio%20E2E",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  };
}

async function renderPrivate(
  path: "/socios" | "/guia-equipo",
  options: {
    env?: NodeJS.ProcessEnv;
    headers?: HeadersInit;
  } = {},
): Promise<{ status: number; html: string }> {
  const response = await requestPreview(path, options);
  return { status: response.status, html: await response.text() };
}

test.afterAll(async () => {
  await closePreviewPool();
});

test("@private keeps anonymous, unconfigured, and denied private responses data-free", async ({
  page,
}) => {
  for (const route of privateRoutes) {
    const configuredEnv = { [route.allowlistKey]: allowedEmail };
    const blockedStates = [
      { headers: undefined, env: configuredEnv },
      { headers: identityHeaders(allowedEmail), env: {} },
      {
        headers: identityHeaders("otra-persona@example.test"),
        env: configuredEnv,
      },
    ] as const;

    for (const state of blockedStates) {
      const response = await renderPrivate(route.path, state);
      assert.equal(response.status, 200);
      if (route.path === "/socios") {
        for (const marker of partnerMarkers) {
          assert.equal(
            response.html.includes(marker),
            false,
            "Una respuesta privada denegada no puede materializar datos de socios",
          );
        }
      }
      await page.setContent(response.html);
      await expect(page.locator("main.private-access-page")).toBeVisible();
      await expect(page.locator(route.allowedSelector)).toHaveCount(0);
    }
  }
});

test("@private renders both authorised private routes without a partner dashboard island", async ({
  page,
}) => {
  const partner = await renderPrivate("/socios", {
    headers: identityHeaders(allowedEmail),
    env: { SOCIOS_ALLOWED_EMAILS: allowedEmail },
  });
  assert.equal(partner.status, 200);
  await page.setContent(partner.html);
  await expect(page.locator("main.partner-page")).toBeVisible();
  await expect(page.locator("main.private-access-page")).toHaveCount(0);
  await expect(page.locator(".partner-account-card > strong")).toHaveText(
    "Socio E2E",
  );
  await expect(page.locator(".partner-account-card > small")).toHaveText(
    allowedEmail,
  );
  await expect(page.locator(".partner-summary-grid > article")).toHaveCount(
    executiveSummary.length,
  );
  await expect(page.locator(".partner-agenda-list > article")).toHaveCount(
    milestoneAgenda.length,
  );
  await expect(page.locator(".partner-roadmap-grid > article")).toHaveCount(
    roadmapPhases.length,
  );
  await expect(page.locator(".partner-metric-grid > article")).toHaveCount(
    financialMetrics.length,
  );
  await expect(page.locator(".partner-material-list > a")).toHaveCount(
    publishedMaterials.length,
  );
  await expect(
    page.locator('.partner-contact-card a[href^="mailto:"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('astro-island[component-export="PartnerDashboard"]'),
  ).toHaveCount(0);

  const guideAnonymous = await renderPrivate("/guia-equipo");
  assert.equal(guideAnonymous.status, 200);
  await page.setContent(guideAnonymous.html);
  await expect(page.locator("main.private-access-page")).toBeVisible();

  const guideAllowed = await renderPrivate("/guia-equipo", {
    headers: identityHeaders(allowedEmail),
    env: { TEAM_ALLOWED_EMAILS: allowedEmail },
  });
  assert.equal(guideAllowed.status, 200);
  await page.setContent(guideAllowed.html);
  await expect(page.locator("main.team-guide-page")).toBeVisible();
});
