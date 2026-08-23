import { expect, test } from "@playwright/test";

const landingPath = "/comunidades-energeticas/manganafer";

test("@manganafer renders its complete static story before form islands hydrate", async ({
  browser,
}) => {
  const port = Number(process.env.PLAYWRIGHT_PORT ?? "4321");
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    let externalRequests = 0;
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => {
      externalRequests += 1;
      return route.abort();
    });
    const response = await page.goto(`http://127.0.0.1:${port}${landingPath}`, {
      waitUntil: "domcontentloaded",
    });

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Si forma parte de tu paisaje, también debería formar parte de tus beneficios.",
    );
    await expect(page.locator(".manganafer-hero-copy .eyebrow")).toHaveText(
      "Comunidad energética de proximidad · Manganáfer",
    );
    await expect(page.locator("[data-manganafer-map]")).toBeVisible();
    await expect(page.locator("form")).toHaveCount(2);
    await expect(page.locator("astro-island")).toHaveCount(4);
    await expect(
      page.locator('astro-island[component-export="ManganaferQuoteForm"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('astro-island[component-export="ManganaferInterestForm"]'),
    ).toHaveCount(1);
    expect(externalRequests).toBe(0);
  } finally {
    await context.close();
  }
});

test("@manganafer keeps both isolated form flows accessible and endpoint-scoped", async ({
  page,
}) => {
  let externalRequests = 0;
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => {
    externalRequests += 1;
    return route.abort();
  });

  let quoteRequests = 0;
  let interestRequests = 0;
  let releaseQuoteSuccess: (() => void) | undefined;
  let releaseInterestError: (() => void) | undefined;
  let signalQuoteSuccessStarted: (() => void) | undefined;
  let signalInterestErrorStarted: (() => void) | undefined;
  const quoteSuccessStarted = new Promise<void>((resolve) => {
    signalQuoteSuccessStarted = resolve;
  });
  const interestErrorStarted = new Promise<void>((resolve) => {
    signalInterestErrorStarted = resolve;
  });

  await page.route("**/api/manganafer-quote", async (route) => {
    quoteRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      cups: "ES0000000000000000XX",
    });

    if (quoteRequests === 2) {
      signalQuoteSuccessStarted?.();
      await new Promise<void>((resolve) => {
        releaseQuoteSuccess = resolve;
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          eligible: true,
          calculable: true,
          distanceMetres: 250,
          estimate: {
            panels: 2,
            annualSaving: 300,
            monthlySaving: 25,
            savingPercentage: 30,
            currentAnnualBill: 1000,
            estimatedAnnualBill: 700,
            projectSaving: 5000,
            monthlyFee: 20,
            annualSolarEnergyKwh: 1300,
            projectYears: 25,
          },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: "No hemos podido preparar la estimación de prueba.",
      }),
    });
  });
  await page.route("**/api/manganafer-interest", async (route) => {
    interestRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toMatchObject({
      kind: "neighbor",
      privacyAccepted: true,
      email: "vecino-e2e@example.test",
    });

    if (interestRequests === 1) {
      signalInterestErrorStarted?.();
      await new Promise<void>((resolve) => {
        releaseInterestError = resolve;
      });
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "No hemos podido guardar el registro de prueba.",
          field: "email",
        }),
      });
      return;
    }

    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  const response = await page.goto(landingPath, {
    waitUntil: "domcontentloaded",
  });
  expect(response?.status()).toBe(200);

  const quote = page.locator("form.manganafer-calculator-form");
  await expect(quote).toHaveCount(1);
  await quote.locator("[name=cups]").fill("ES0000000000000000XX");
  await quote.getByRole("button", { name: "Ver mi estimación" }).click();
  await expect(
    page.locator(".manganafer-calculator-result[aria-live=polite]"),
  ).toContainText("No hemos podido preparar la estimación de prueba.");
  expect(quoteRequests).toBe(1);

  await page.reload({ waitUntil: "domcontentloaded" });
  const quoteSuccess = page.locator("form.manganafer-calculator-form");
  await quoteSuccess.locator("[name=cups]").fill("ES0000000000000000XX");
  await quoteSuccess.getByRole("button", { name: "Ver mi estimación" }).click();
  await quoteSuccessStarted;
  await expect(
    quoteSuccess.getByRole("button", { name: "Calculando…" }),
  ).toBeDisabled();
  releaseQuoteSuccess?.();
  await expect(page.locator(".manganafer-quote-success")).toContainText(
    "Ahorro estimado al año",
  );
  expect(quoteRequests).toBe(2);

  const interest = page.locator(".manganafer-form-card form");
  await expect(interest).toHaveCount(1);
  await interest.locator("[name=firstName]").fill("Vecino");
  await interest.locator("[name=lastName]").fill("De prueba");
  await interest.locator("[name=email]").fill("vecino-e2e@example.test");
  await interest.locator("[name=phone]").fill("600000000");
  await interest.locator("[name=municipality]").fill("Cartagena");
  await interest.locator("[name=postalCode]").fill("30385");
  await interest.locator("[name=participantProfile]").selectOption("hogar");
  await interest.locator("[name=privacyAccepted]").check();
  await interest.getByRole("button", { name: "Quiero formar parte" }).click();
  await interestErrorStarted;
  await expect(
    interest.getByRole("button", { name: "Guardando…" }),
  ).toBeDisabled();
  releaseInterestError?.();
  await expect(page.getByRole("alert")).toContainText(
    "No hemos podido guardar el registro de prueba.",
  );
  await interest.getByRole("button", { name: "Quiero formar parte" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Ya formas parte de la lista de interesados.",
  );
  expect(interestRequests).toBe(2);
  expect(externalRequests).toBe(0);
});
