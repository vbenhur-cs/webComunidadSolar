import assert from "node:assert/strict";

import { expect, test } from "@playwright/test";

import { withLocalD1Worker } from "../helpers/wrangler-local.ts";

const allowedEmail = "admin-synthetic@example.test";
const deniedEmail = "blocked-synthetic@example.test";

// Each state group owns an isolated emitted Worker plus local D1, so this is
// intentionally larger than Playwright's default page-interaction timeout.
test.setTimeout(150_000);

function identityHeaders(email: string): HeadersInit {
  return {
    "oai-authenticated-user-email": email,
    "oai-authenticated-user-full-name": "Admin%20Synthetic",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  };
}

function interestPayload(overrides: Record<string, unknown> = {}) {
  return {
    kind: "neighbor",
    firstName: "Registro",
    lastName: "Sintetico",
    email: "entry-synthetic@example.test",
    phone: "600000000",
    municipality: "Zona sintética",
    postalCode: "30385",
    address: "Dirección sintética",
    participantProfile: "hogar",
    message: "Mensaje sintético.",
    privacyAccepted: true,
    ...overrides,
  };
}

async function render(
  fetchWorker: (path: string, init?: RequestInit) => Promise<Response>,
  headers?: HeadersInit,
): Promise<Response> {
  return fetchWorker("/manganafer/interesados", { headers });
}

test("@manganafer keeps private admin walls data-free before D1 and renders ordered data only to an allowed identity", async ({
  page,
}) => {
  await withLocalD1Worker(
    async ({ fetch, query }) => {
      const anonymous = await render(fetch);
      assert.equal(anonymous.status, 200);
      assert.equal(anonymous.headers.get("cache-control"), "private, no-store");
      const anonymousHtml = await anonymous.text();
      assert.equal(anonymousHtml.includes("manganafer-admin-page"), false);
      await page.setContent(anonymousHtml);
      await expect(page.locator("main.private-access-page")).toBeVisible();

      const denied = await render(fetch, identityHeaders(deniedEmail));
      assert.equal(denied.status, 200);
      const deniedHtml = await denied.text();
      assert.equal(deniedHtml.includes("manganafer-admin-page"), false);

      const empty = await render(fetch, identityHeaders(allowedEmail));
      assert.equal(empty.status, 200);
      const emptyHtml = await empty.text();
      await page.setContent(emptyHtml);
      await expect(page.locator("main.manganafer-admin-page")).toBeVisible();
      await expect(page.locator(".manganafer-admin-empty")).toBeVisible();
      await expect(page.locator(".manganafer-admin-table")).toHaveCount(0);

      for (const payload of [
        interestPayload(),
        interestPayload({
          kind: "roof",
          email: "roof-synthetic@example.test",
          roofSurfaceRange: "500-1000",
          roofRelationship: "propietario",
          participantProfile: undefined,
        }),
      ]) {
        const stored = await fetch("/api/manganafer-interest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        assert.equal(stored.status, 201);
      }
      await query(
        "UPDATE manganafer_interests SET created_at = CASE kind WHEN 'neighbor' THEN '2026-08-23 11:00:00' ELSE '2026-08-23 12:00:00' END",
      );

      const allowed = await render(fetch, identityHeaders(allowedEmail));
      assert.equal(allowed.status, 200);
      assert.equal(
        allowed.headers.get("x-robots-tag"),
        "noindex, nofollow, noarchive, noimageindex",
      );
      await page.setContent(await allowed.text());
      await expect(
        page.locator(".manganafer-admin-table tbody tr"),
      ).toHaveCount(2);
      await expect(
        page.locator(".manganafer-admin-table time").first(),
      ).toHaveAttribute("datetime", "2026-08-23 12:00:00");
      await expect(
        page.locator(".manganafer-admin-stats > article"),
      ).toHaveCount(4);

      const exportResponse = await fetch("/api/manganafer-interest/export", {
        headers: identityHeaders(allowedEmail),
      });
      assert.equal(exportResponse.status, 200);
      assert.equal(
        exportResponse.headers.get("content-type"),
        "text/csv; charset=utf-8",
      );
      const exportBytes = new Uint8Array(await exportResponse.arrayBuffer());
      assert.deepEqual([...exportBytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
      assert.equal(
        new TextDecoder().decode(exportBytes.slice(3)).split("\r\n").length,
        3,
      );
    },
    { syntheticBindings: { MANGANAFER_ALLOWED_EMAILS: allowedEmail } },
  );

  await withLocalD1Worker(async ({ fetch }) => {
    const unconfigured = await render(fetch, identityHeaders(allowedEmail));
    assert.equal(unconfigured.status, 200);
    const unconfiguredHtml = await unconfigured.text();
    assert.equal(unconfiguredHtml.includes("manganafer-admin-page"), false);
    await page.setContent(unconfiguredHtml);
    await expect(page.locator("main.private-access-page")).toBeVisible();
  }, {});
});
