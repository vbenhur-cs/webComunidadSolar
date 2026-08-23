import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  handleQuoteRequest,
  nearestPlantDistance,
} from "../../src/lib/manganafer/quote.ts";
import {
  getManganaferQuoteConfig,
  selectManganaferQuoteEnvironment,
} from "../../src/lib/manganafer/quote-config.ts";

const quotePath = "https://example.test/api/manganafer-quote";
const cupsPath = "https://api-contratacion.comunidadsolar.es/cups/consultar";
const quotingPath = "https://quoting-new.51.44.13.132.nip.io/api/simular";
const validCups = "ES1234567890123456AB";

const validEnvironment = {
  MANGANAFER_QUOTING_BEARER_TOKEN: "synthetic-bearer-token",
  MANGANAFER_PANEL_MONTHLY_FEE: "18",
  MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT: "14.876",
  MANGANAFER_PANEL_FEE_VAT: "0.21",
  MANGANAFER_AVAILABLE_PANELS: "3",
  MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH: "600",
  MANGANAFER_DISCOUNT: "0.12",
  MANGANAFER_PANEL_POWER_W: "540",
  MANGANAFER_ANNUAL_DEGRADATION: "0.005",
  MANGANAFER_MAXIMUM_PANELS_PER_QUOTE: "3",
};

async function fixtureJson(name: "cups-success" | "quote-success") {
  const text = await readFile(
    new URL(`../fixtures/manganafer/${name}.json`, import.meta.url),
    "utf8",
  );
  return JSON.parse(text) as Record<string, unknown>;
}

function jsonRequest(payload: unknown, headers: HeadersInit = {}) {
  return new Request(quotePath, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

function streamRequest(payload: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  return new Request(quotePath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
}

function fixtureFetch(
  responder: (
    url: string,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return responder(url, init);
  };
  return { calls, fetcher };
}

function assertPrivateNoStore(response: Response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive",
  );
}

test("rejects a malformed CUPS without calling an upstream", async () => {
  const upstream = fixtureFetch(() => {
    throw new Error("An invalid CUPS must not reach an upstream");
  });

  const response = await handleQuoteRequest(jsonRequest({ cups: "bad" }), {
    env: validEnvironment,
    fetcher: upstream.fetcher,
  });

  assert.equal(response.status, 400);
  assertPrivateNoStore(response);
  assert.deepEqual(await response.json(), {
    ok: false,
    field: "cups",
    error: "Comprueba el CUPS: debe empezar por ES y tener 20 o 22 caracteres.",
  });
  assert.equal(upstream.calls.length, 0);
});

test("uses source configuration only when every explicit environment value is valid", () => {
  assert.equal(getManganaferQuoteConfig({}), null);
  assert.deepEqual(getManganaferQuoteConfig(validEnvironment), {
    bearerToken: "synthetic-bearer-token",
    monthlyPanelFee: 18,
    monthlyPanelFeeWithoutVat: 14.876,
    vat: 0.21,
    availablePanels: 3,
    annualPanelProductionKwh: 600,
    discount: 0.12,
    panelPowerW: 540,
    annualDegradation: 0.005,
    maximumPanelsPerQuote: 3,
    projectYears: 25,
  });
});

test("preserves every commercial configuration boundary and source numeric coercion", () => {
  for (const [name, value] of [
    ["MANGANAFER_QUOTING_BEARER_TOKEN", ""],
    ["MANGANAFER_PANEL_MONTHLY_FEE", "-0.01"],
    ["MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT", "-0.01"],
    ["MANGANAFER_PANEL_FEE_VAT", "-0.01"],
    ["MANGANAFER_PANEL_FEE_VAT", "1.01"],
    ["MANGANAFER_AVAILABLE_PANELS", "0"],
    ["MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH", "0"],
    ["MANGANAFER_DISCOUNT", "-0.01"],
    ["MANGANAFER_DISCOUNT", "1.01"],
    ["MANGANAFER_PANEL_POWER_W", "0"],
    ["MANGANAFER_ANNUAL_DEGRADATION", "-0.01"],
    ["MANGANAFER_ANNUAL_DEGRADATION", "1.01"],
  ] as const) {
    assert.equal(
      getManganaferQuoteConfig({ ...validEnvironment, [name]: value }),
      null,
    );
  }

  for (const name of [
    "MANGANAFER_PANEL_MONTHLY_FEE",
    "MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT",
    "MANGANAFER_PANEL_FEE_VAT",
    "MANGANAFER_DISCOUNT",
    "MANGANAFER_ANNUAL_DEGRADATION",
  ] as const) {
    assert.notEqual(
      getManganaferQuoteConfig({ ...validEnvironment, [name]: "" }),
      null,
    );
  }
  assert.equal(
    getManganaferQuoteConfig({
      ...validEnvironment,
      MANGANAFER_AVAILABLE_PANELS: "",
    }),
    null,
  );
  assert.equal(
    getManganaferQuoteConfig({
      ...validEnvironment,
      MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH: "",
    }),
    null,
  );
  assert.equal(
    getManganaferQuoteConfig({
      ...validEnvironment,
      MANGANAFER_PANEL_POWER_W: "",
    }),
    null,
  );

  const rounded = getManganaferQuoteConfig({
    ...validEnvironment,
    MANGANAFER_AVAILABLE_PANELS: "3.9",
    MANGANAFER_PANEL_POWER_W: "540.6",
  });
  assert.equal(rounded?.availablePanels, 3);
  assert.equal(rounded?.panelPowerW, 541);
  assert.equal(
    getManganaferQuoteConfig({
      ...validEnvironment,
      MANGANAFER_MAXIMUM_PANELS_PER_QUOTE: undefined,
    })?.maximumPanelsPerQuote,
    12,
  );
  assert.equal(
    getManganaferQuoteConfig({
      ...validEnvironment,
      MANGANAFER_MAXIMUM_PANELS_PER_QUOTE: "",
    })?.maximumPanelsPerQuote,
    1,
  );
  assert.equal(
    getManganaferQuoteConfig({
      ...validEnvironment,
      MANGANAFER_MAXIMUM_PANELS_PER_QUOTE: "0",
    })?.maximumPanelsPerQuote,
    1,
  );
  assert.equal(
    getManganaferQuoteConfig({
      ...validEnvironment,
      MANGANAFER_MAXIMUM_PANELS_PER_QUOTE: "25.9",
    })?.maximumPanelsPerQuote,
    24,
  );
});

test("selects only the ten quote bindings from a larger Worker environment", () => {
  const environment = selectManganaferQuoteEnvironment({
    ...validEnvironment,
    DB: "must-not-reach-the-quote-service",
    ASSETS: "must-not-reach-the-quote-service",
    UNRELATED_SECRET: "must-not-reach-the-quote-service",
  });

  assert.deepEqual(environment, validEnvironment);
  assert.deepEqual(Object.keys(environment), Object.keys(validEnvironment));
});

test("rejects source header and stream bodies above the exact 4096-byte limit", async () => {
  for (const contentLength of ["4097", "24001"]) {
    const upstream = fixtureFetch(() => {
      throw new Error("An oversized request must not reach an upstream");
    });
    const response = await handleQuoteRequest(
      jsonRequest({ cups: validCups }, { "content-length": contentLength }),
      { env: validEnvironment, fetcher: upstream.fetcher },
    );
    assert.equal(response.status, 413);
    assertPrivateNoStore(response);
    assert.equal(upstream.calls.length, 0);
  }

  const upstream = fixtureFetch(() => {
    throw new Error("An oversized stream must not reach an upstream");
  });
  const oversized = streamRequest({
    cups: validCups,
    padding: "x".repeat(4_100),
  });
  assert.equal(oversized.headers.get("content-length"), null);
  const response = await handleQuoteRequest(oversized, {
    env: validEnvironment,
    fetcher: upstream.fetcher,
  });
  assert.equal(response.status, 413);
  assertPrivateNoStore(response);
  assert.equal(upstream.calls.length, 0);
});

test("returns a source-faithful business result for a valid CUPS outside one kilometre", async () => {
  const cups = await fixtureJson("cups-success");
  cups.suministro_lat = 37.7;
  cups.suministro_lon = -0.9;
  const upstream = fixtureFetch((url) => {
    assert.match(url, new RegExp(`^${cupsPath}`));
    return Response.json(cups);
  });

  const response = await handleQuoteRequest(jsonRequest({ cups: validCups }), {
    env: validEnvironment,
    fetcher: upstream.fetcher,
  });

  assert.equal(response.status, 200);
  assertPrivateNoStore(response);
  assert.deepEqual(await response.json(), {
    ok: true,
    eligible: false,
    distanceMetres: Math.round(nearestPlantDistance(37.7, -0.9) / 10) * 10,
    maximumCoverageMetres: 1_000,
  });
  assert.equal(upstream.calls.length, 1);
});

test("reports unavailable configuration before contacting either upstream", async () => {
  const upstream = fixtureFetch(() => {
    throw new Error("An unconfigured quote must not reach an upstream");
  });

  const response = await handleQuoteRequest(jsonRequest({ cups: validCups }), {
    env: {},
    fetcher: upstream.fetcher,
  });

  assert.equal(response.status, 503);
  assertPrivateNoStore(response);
  assert.deepEqual(await response.json(), {
    ok: false,
    error:
      "La calculadora de Manganáfer todavía no está disponible. Puedes dejar tus datos en el registro de interés.",
  });
  assert.equal(upstream.calls.length, 0);
});

test("maps a failed non-JSON CUPS response and incomplete invoice to source errors", async () => {
  const nonJson = fixtureFetch(() => new Response("not JSON", { status: 502 }));
  const nonJsonResponse = await handleQuoteRequest(
    jsonRequest({ cups: validCups }),
    { env: validEnvironment, fetcher: nonJson.fetcher },
  );
  assert.equal(nonJsonResponse.status, 400);
  assert.deepEqual(await nonJsonResponse.json(), {
    ok: false,
    field: "cups",
    error:
      "No hemos podido consultar ese CUPS. Comprueba que está bien escrito.",
  });

  const incomplete = await fixtureJson("cups-success");
  delete incomplete.periodo_inicio;
  const missingInvoice = fixtureFetch(() => Response.json(incomplete));
  const missingInvoiceResponse = await handleQuoteRequest(
    jsonRequest({ cups: validCups }),
    { env: validEnvironment, fetcher: missingInvoice.fetcher },
  );
  assert.equal(missingInvoiceResponse.status, 422);
  assert.deepEqual(await missingInvoiceResponse.json(), {
    ok: false,
    error:
      "El CUPS está dentro de la zona, pero faltan datos de consumo para preparar una estimación automática. Déjanos tus datos y la completaremos contigo.",
  });
});

test("maps a successful non-JSON CUPS response to the source location fallback", async () => {
  const upstream = fixtureFetch(() => new Response("not JSON"));
  const response = await handleQuoteRequest(jsonRequest({ cups: validCups }), {
    env: validEnvironment,
    fetcher: upstream.fetcher,
  });

  assert.equal(response.status, 422);
  assertPrivateNoStore(response);
  assert.deepEqual(await response.json(), {
    ok: false,
    error:
      "Hemos leído el CUPS, pero no hemos podido confirmar automáticamente su ubicación. Déjanos tus datos y lo comprobaremos contigo.",
  });
  assert.equal(upstream.calls.length, 1);
});

test("returns the source generic error when an upstream throws", async () => {
  const upstream = fixtureFetch(() => {
    throw new Error("synthetic upstream detail");
  });
  const response = await handleQuoteRequest(jsonRequest({ cups: validCups }), {
    env: validEnvironment,
    fetcher: upstream.fetcher,
  });

  assert.equal(response.status, 502);
  assertPrivateNoStore(response);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: false,
    error:
      "No hemos podido preparar la estimación en este momento. Inténtalo de nuevo en unos minutos.",
  });
  assert.doesNotMatch(JSON.stringify(body), /synthetic upstream detail/);
});

test("returns a non-calculable response when every quote candidate is unusable", async () => {
  const cups = await fixtureJson("cups-success");
  let quoteCalls = 0;
  const upstream = fixtureFetch((url) => {
    if (url.startsWith(cupsPath)) return Response.json(cups);
    assert.equal(url, quotingPath);
    quoteCalls += 1;
    return Response.json({ no_calculable: true });
  });

  const response = await handleQuoteRequest(jsonRequest({ cups: validCups }), {
    env: validEnvironment,
    fetcher: upstream.fetcher,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    eligible: true,
    calculable: false,
    distanceMetres: 0,
    maximumCoverageMetres: 1_000,
  });
  assert.equal(quoteCalls, 3);
});

test("treats successful non-JSON quote responses as non-calculable", async () => {
  const cups = await fixtureJson("cups-success");
  const upstream = fixtureFetch((url) => {
    if (url.startsWith(cupsPath)) return Response.json(cups);
    assert.equal(url, quotingPath);
    return new Response("not JSON");
  });

  const response = await handleQuoteRequest(jsonRequest({ cups: validCups }), {
    env: validEnvironment,
    fetcher: upstream.fetcher,
  });

  assert.equal(response.status, 200);
  assertPrivateNoStore(response);
  assert.deepEqual(await response.json(), {
    ok: true,
    eligible: true,
    calculable: false,
    distanceMetres: 0,
    maximumCoverageMetres: 1_000,
  });
});

test("selects the best positive panel quote and preserves the upstream payload fields", async () => {
  const cups = await fixtureJson("cups-success");
  const quote = await fixtureJson("quote-success");
  const quotedPanels: number[] = [];
  const upstream = fixtureFetch((url, init) => {
    if (url.startsWith(cupsPath)) {
      assert.equal(url, `${cupsPath}?cups=${encodeURIComponent(validCups)}`);
      assert.deepEqual(init?.headers, { Accept: "application/json" });
      return Response.json(cups);
    }
    assert.equal(url, quotingPath);
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, {
      Accept: "application/json",
      Authorization: "Bearer synthetic-bearer-token",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.modo, "alquiler");
    assert.equal(body.modo_calculo, "sin_desvios");
    assert.equal(body.años_proyecto, 25);
    assert.equal(
      (body.factura_cliente as Record<string, unknown>).cups,
      validCups,
    );
    assert.deepEqual(body.ce_config, {
      ce_nombre: "Manganáfer",
      ce_status: "Waiting list",
      cuota_alquiler_mes: 18,
      cuota_alquiler_sin_iva: 14.876,
      iva: 0.21,
      paneles_disponibles: 3,
      produccion_anual_panel_kwh: 600,
      descuento: 0.12,
      tipo_panel_w: 540,
      degradacion_solar: 0.005,
    });
    const panels = Number(body.n_cep_alquiler_540w);
    quotedPanels.push(panels);
    const response = structuredClone(quote) as Record<string, unknown>;
    const kpi = response.resultados_kpi as Record<string, unknown>;
    kpi.ahorro_anual_medio = panels === 3 ? 310 : panels === 2 ? 220 : -10;
    return Response.json(response);
  });

  const response = await handleQuoteRequest(
    jsonRequest({ cups: " es1234 5678 9012 3456ab " }),
    { env: validEnvironment, fetcher: upstream.fetcher },
  );

  assert.equal(response.status, 200);
  assertPrivateNoStore(response);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.eligible, true);
  assert.equal(body.calculable, true);
  assert.deepEqual(quotedPanels, [1, 2, 3]);
  assert.deepEqual(body.estimate, {
    panels: 3,
    annualSaving: 310,
    monthlySaving: 17.5,
    savingPercentage: 23,
    currentAnnualBill: 900,
    estimatedAnnualBill: 690,
    projectSaving: 5250,
    monthlyFee: 18,
    annualSolarEnergyKwh: 1200,
    projectYears: 25,
  });
  assert.doesNotMatch(
    JSON.stringify(body),
    /synthetic-bearer-token|ES1234567890123456AB/,
  );
});

test("calculates the nearest source plant distance", () => {
  assert.equal(nearestPlantDistance(37.61395, -0.78202), 0);
  assert.ok(nearestPlantDistance(37.7, -0.9) > 1_000);
});
