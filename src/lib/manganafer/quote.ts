import {
  getManganaferQuoteConfig,
  type ManganaferQuoteEnvironment,
} from "./quote-config.ts";

type UnknownRecord = Record<string, unknown>;

type QuoteCandidate = {
  panels: number;
  annualSaving: number;
  monthlySaving: number;
  savingPercentage: number;
  currentAnnualBill: number;
  estimatedAnnualBill: number;
  projectSaving: number;
  monthlyFee: number;
  annualSolarEnergyKwh: number;
};

export interface QuoteRequestDependencies {
  env: ManganaferQuoteEnvironment;
  fetcher: typeof fetch;
}

const cupsApiUrl = "https://api-contratacion.comunidadsolar.es/cups/consultar";
const quotingApiUrl = "https://quoting-new.51.44.13.132.nip.io/api/simular";
const maximumRequestBytes = 4_096;
const maximumCoverageMetres = 1_000;
const plantReferencePoints = [
  { latitude: 37.61395, longitude: -0.78202 },
  { latitude: 37.60767, longitude: -0.7884 },
];

function noStoreJson(
  body: UnknownRecord,
  init: { status?: number } = {},
): Response {
  return Response.json(body, {
    status: init.status,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const number = asNumber(value);
  return number === null ? "" : String(number);
}

function normalizeCups(value: unknown): string {
  return asString(value).replace(/\s+/g, "").toUpperCase();
}

function isValidCups(value: string): boolean {
  return /^ES\d{16}[A-Z]{2}(?:[0-9A-Z]{2})?$/.test(value);
}

function invoiceSource(payload: UnknownRecord): UnknownRecord {
  for (const key of ["factura", "factura_cliente", "data", "resultado"]) {
    if (isRecord(payload[key])) {
      return { ...payload, ...payload[key] };
    }
  }
  return payload;
}

function coordinate(payload: UnknownRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = asNumber(payload[key]);
    if (value !== null) return value;
  }
  return null;
}

function haversineMetres(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusMetres = 6_371_000;
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const latitudeARadians = toRadians(latitudeA);
  const latitudeBRadians = toRadians(latitudeB);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeARadians) *
      Math.cos(latitudeBRadians) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    2 *
    earthRadiusMetres *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

export function nearestPlantDistance(
  latitude: number,
  longitude: number,
): number {
  return Math.min(
    ...plantReferencePoints.map((point) =>
      haversineMetres(latitude, longitude, point.latitude, point.longitude),
    ),
  );
}

function facturaCliente(
  source: UnknownRecord,
  cups: string,
): UnknownRecord | null {
  const requiredStrings = {
    periodo_inicio: asText(source.periodo_inicio),
    periodo_fin: asText(source.periodo_fin),
    dias_facturados: asText(source.dias_facturados),
    tarifa_acceso: asText(source.tarifa_acceso),
  };
  const requiredNumbers = {
    pot_p1_kw: asNumber(source.pot_p1_kw),
    pot_p2_kw: asNumber(source.pot_p2_kw),
    imp_ele: asNumber(source.imp_ele),
    iva: asNumber(source.iva),
    alq_eq_dia: asNumber(source.alq_eq_dia),
  };

  if (
    Object.values(requiredStrings).some((value) => !value) ||
    Object.values(requiredNumbers).some((value) => value === null)
  ) {
    return null;
  }

  const optionalNumbers = [
    "pot_p3_kw",
    "pot_p4_kw",
    "pot_p5_kw",
    "pot_p6_kw",
    "pp_p1",
    "pp_p2",
    "pp_p3",
    "pp_p4",
    "pp_p5",
    "pp_p6",
    "bono_social",
    "pe_p1",
    "pe_p2",
    "pe_p3",
    "pe_p4",
    "pe_p5",
    "pe_p6",
    "consumo_p1_kwh",
    "consumo_p2_kwh",
    "consumo_p3_kwh",
    "consumo_p4_kwh",
    "consumo_p5_kwh",
    "consumo_p6_kwh",
    "importe_factura",
  ];
  const invoice: UnknownRecord = {
    cups,
    ...requiredStrings,
    ...requiredNumbers,
    comercializadora: asString(source.comercializadora) || null,
    distribuidora: asString(source.distribuidora) || null,
    tipo_precio_energia: asString(source.tipo_precio_energia) || null,
    pp_unidad: asString(source.pp_unidad) || null,
    api_ok: source.api_ok !== false,
  };

  for (const key of optionalNumbers) {
    invoice[key] = asNumber(source[key]);
  }

  return invoice;
}

function annualizedConsumption(invoice: UnknownRecord): number {
  const billedDays = Math.max(1, asNumber(invoice.dias_facturados) ?? 30);
  const periodConsumption = [
    "consumo_p1_kwh",
    "consumo_p2_kwh",
    "consumo_p3_kwh",
    "consumo_p4_kwh",
    "consumo_p5_kwh",
    "consumo_p6_kwh",
  ].reduce((total, key) => total + (asNumber(invoice[key]) ?? 0), 0);

  return (periodConsumption / billedDays) * 365;
}

function quoteCandidate(
  payload: unknown,
  panels: number,
): QuoteCandidate | null {
  if (!isRecord(payload) || payload.no_calculable === true) return null;
  const kpi = isRecord(payload.resultados_kpi) ? payload.resultados_kpi : null;
  if (!kpi) return null;

  const annualSaving = asNumber(kpi.ahorro_anual_medio);
  const monthlySaving = asNumber(kpi.ahorro_mensual_medio);
  const savingPercentage = asNumber(kpi.pct_ahorro_anual);
  const currentAnnualBill = asNumber(kpi.factura_anual_actual);
  const estimatedAnnualBill = asNumber(kpi.factura_anual_cecs);
  const monthlyFee = asNumber(kpi.cuota_alquiler_mensual);
  const annualSolarEnergyKwh = asNumber(kpi.produccion_ar_anual_kwh);
  const projection = isRecord(payload.proyeccion_financiera)
    ? payload.proyeccion_financiera
    : null;
  const cashflow = Array.isArray(projection?.tabla_cashflow)
    ? projection.tabla_cashflow
    : [];
  const lastYear = cashflow.at(-1);
  const projectSaving = isRecord(lastYear)
    ? asNumber(lastYear.ahorro_acumulado)
    : null;

  if (
    annualSaving === null ||
    monthlySaving === null ||
    savingPercentage === null ||
    currentAnnualBill === null ||
    estimatedAnnualBill === null ||
    monthlyFee === null ||
    annualSolarEnergyKwh === null ||
    projectSaving === null
  ) {
    return null;
  }

  return {
    panels,
    annualSaving,
    monthlySaving,
    savingPercentage,
    currentAnnualBill,
    estimatedAnnualBill,
    projectSaving,
    monthlyFee,
    annualSolarEnergyKwh,
  };
}

async function readJsonBody(
  request: Request,
): Promise<
  { kind: "body"; value: string } | { kind: "too-large" } | { kind: "invalid" }
> {
  if (request.body === null) return { kind: "invalid" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumRequestBytes) {
        await reader.cancel();
        return { kind: "too-large" };
      }
      chunks.push(next.value);
    }
  } catch {
    return { kind: "invalid" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "body", value: new TextDecoder().decode(bytes) };
}

function requestTooLarge(): Response {
  return noStoreJson(
    { ok: false, error: "La solicitud es demasiado grande." },
    { status: 413 },
  );
}

/**
 * Uses only explicit environment and fetch dependencies so local tests never
 * contact quoting services or inherit process-wide secrets.
 */
export async function handleQuoteRequest(
  request: Request,
  { env, fetcher }: QuoteRequestDependencies,
): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maximumRequestBytes) return requestTooLarge();

  const body = await readJsonBody(request);
  if (body.kind === "too-large") return requestTooLarge();
  if (body.kind === "invalid") {
    return noStoreJson(
      { ok: false, error: "No hemos podido leer el CUPS." },
      { status: 400 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.value) as unknown;
  } catch {
    return noStoreJson(
      { ok: false, error: "No hemos podido leer el CUPS." },
      { status: 400 },
    );
  }
  if (!isRecord(payload)) {
    return noStoreJson(
      { ok: false, error: "No hemos podido leer el CUPS." },
      { status: 400 },
    );
  }

  const cups = normalizeCups(payload.cups);
  if (!isValidCups(cups)) {
    return noStoreJson(
      {
        ok: false,
        field: "cups",
        error:
          "Comprueba el CUPS: debe empezar por ES y tener 20 o 22 caracteres.",
      },
      { status: 400 },
    );
  }

  const config = getManganaferQuoteConfig(env);
  if (!config) {
    return noStoreJson(
      {
        ok: false,
        error:
          "La calculadora de Manganáfer todavía no está disponible. Puedes dejar tus datos en el registro de interés.",
      },
      { status: 503 },
    );
  }

  try {
    const cupsResponse = await fetcher(
      `${cupsApiUrl}?cups=${encodeURIComponent(cups)}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const cupsPayload = await cupsResponse.json().catch(() => ({}));
    if (!cupsResponse.ok || !isRecord(cupsPayload)) {
      const detail = isRecord(cupsPayload) ? asString(cupsPayload.detail) : "";
      return noStoreJson(
        {
          ok: false,
          field: "cups",
          error:
            detail ||
            "No hemos podido consultar ese CUPS. Comprueba que está bien escrito.",
        },
        { status: 400 },
      );
    }

    const source = invoiceSource(cupsPayload);
    const latitude = coordinate(source, [
      "suministro_lat",
      "latitud_suministro",
      "latitude",
      "lat",
    ]);
    const longitude = coordinate(source, [
      "suministro_lon",
      "suministro_lng",
      "longitud_suministro",
      "longitude",
      "lon",
      "lng",
    ]);
    if (latitude === null || longitude === null) {
      return noStoreJson(
        {
          ok: false,
          error:
            "Hemos leído el CUPS, pero no hemos podido confirmar automáticamente su ubicación. Déjanos tus datos y lo comprobaremos contigo.",
        },
        { status: 422 },
      );
    }

    const distanceMetres = nearestPlantDistance(latitude, longitude);
    if (distanceMetres > maximumCoverageMetres) {
      return noStoreJson({
        ok: true,
        eligible: false,
        distanceMetres: Math.round(distanceMetres / 10) * 10,
        maximumCoverageMetres,
      });
    }

    const invoice = facturaCliente(source, cups);
    if (!invoice) {
      return noStoreJson(
        {
          ok: false,
          error:
            "El CUPS está dentro de la zona, pero faltan datos de consumo para preparar una estimación automática. Déjanos tus datos y la completaremos contigo.",
        },
        { status: 422 },
      );
    }

    const annualConsumption = annualizedConsumption(invoice);
    const suggestedMaximum = Math.max(
      2,
      Math.ceil((annualConsumption / config.annualPanelProductionKwh) * 1.35),
    );
    const maximumPanels = Math.min(
      suggestedMaximum,
      config.maximumPanelsPerQuote,
      config.availablePanels,
    );
    const panelOptions = Array.from(
      { length: maximumPanels },
      (_, index) => index + 1,
    );

    const quoteResponses = await Promise.all(
      panelOptions.map(async (panels) => {
        const response = await fetcher(quotingApiUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${config.bearerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            factura_cliente: invoice,
            modo: "alquiler",
            modo_calculo: "sin_desvios",
            n_cep_alquiler_540w: panels,
            cuota_alquiler_mes: config.monthlyPanelFee,
            descuento: config.discount,
            años_proyecto: config.projectYears,
            id_generacion: null,
            ce_config: {
              ce_nombre: "Manganáfer",
              ce_status: "Waiting list",
              cuota_alquiler_mes: config.monthlyPanelFee,
              cuota_alquiler_sin_iva: config.monthlyPanelFeeWithoutVat,
              iva: config.vat,
              paneles_disponibles: config.availablePanels,
              produccion_anual_panel_kwh: config.annualPanelProductionKwh,
              descuento: config.discount,
              tipo_panel_w: config.panelPowerW,
              degradacion_solar: config.annualDegradation,
            },
          }),
          signal: AbortSignal.timeout(20_000),
        });
        const responsePayload = await response.json().catch(() => ({}));
        if (!response.ok) return null;
        return quoteCandidate(responsePayload, panels);
      }),
    );

    const candidates = quoteResponses
      .filter((candidate): candidate is QuoteCandidate => candidate !== null)
      .sort((candidateA, candidateB) => {
        const positiveA = candidateA.annualSaving > 0 ? 1 : 0;
        const positiveB = candidateB.annualSaving > 0 ? 1 : 0;
        return (
          positiveB - positiveA ||
          candidateB.annualSaving - candidateA.annualSaving
        );
      });
    const bestQuote = candidates[0];

    if (!bestQuote || bestQuote.annualSaving <= 0) {
      return noStoreJson({
        ok: true,
        eligible: true,
        calculable: false,
        distanceMetres: Math.round(distanceMetres / 10) * 10,
        maximumCoverageMetres,
      });
    }

    return noStoreJson({
      ok: true,
      eligible: true,
      calculable: true,
      distanceMetres: Math.round(distanceMetres / 10) * 10,
      maximumCoverageMetres,
      estimate: {
        ...bestQuote,
        projectYears: config.projectYears,
      },
    });
  } catch {
    return noStoreJson(
      {
        ok: false,
        error:
          "No hemos podido preparar la estimación en este momento. Inténtalo de nuevo en unos minutos.",
      },
      { status: 502 },
    );
  }
}
