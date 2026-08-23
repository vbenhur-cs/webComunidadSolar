export type InterestKind = "neighbor" | "roof";

export interface ManganaferInterest {
  kind: InterestKind;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  municipality: string;
  postalCode: string;
  address: string;
  participantProfile: string;
  roofSurfaceRange: string;
  roofRelationship: string;
  message: string;
  consentVersion: "2026-07-31";
  source: "manganafer-landing";
  status: "nuevo";
}

export type InterestValidationResult =
  | { ok: true; value: ManganaferInterest }
  | { ok: false; error: string; field?: string };

export interface InterestRequestDependencies<Database = unknown> {
  db: Database;
  ensureStorage(db: Database): Promise<void>;
  persistInterest(
    db: Database,
    interest: ManganaferInterest,
  ): Promise<{ id: number; kind: InterestKind }>;
}

const maximumRequestBytes = 24_000;
const participantProfiles = new Set(["hogar", "negocio", "asociacion", "otro"]);
const roofSurfaceRanges = new Set([
  "menos-500",
  "500-1000",
  "1000-2000",
  "mas-2000",
  "no-se",
]);
const roofRelationships = new Set([
  "propietario",
  "representante",
  "arrendatario",
  "otro",
]);

function text(value: unknown, maximumLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximumLength) : "";
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isPhone(value: string): boolean {
  return value.replace(/\D/g, "").length >= 9;
}

function invalid(error: string, field?: string): InterestValidationResult {
  return { ok: false, error, field };
}

function fieldValue(payload: unknown, field: string): unknown {
  if (typeof payload !== "object" || payload === null) return undefined;
  return (payload as Record<string, unknown>)[field];
}

export function validateInterestPayload(
  payload: unknown,
): InterestValidationResult {
  const kind = text(fieldValue(payload, "kind"), 20) as InterestKind;
  const firstName = text(fieldValue(payload, "firstName"), 80);
  const lastName = text(fieldValue(payload, "lastName"), 120);
  const email = text(fieldValue(payload, "email"), 180).toLowerCase();
  const phone = text(fieldValue(payload, "phone"), 40);
  const municipality = text(fieldValue(payload, "municipality"), 120);
  const postalCode = text(fieldValue(payload, "postalCode"), 5);
  const address = text(fieldValue(payload, "address"), 240);
  const participantProfile = text(
    fieldValue(payload, "participantProfile"),
    40,
  );
  const roofSurfaceRange = text(fieldValue(payload, "roofSurfaceRange"), 40);
  const roofRelationship = text(fieldValue(payload, "roofRelationship"), 40);
  const message = text(fieldValue(payload, "message"), 1_200);

  if (kind !== "neighbor" && kind !== "roof") {
    return invalid("Elige cómo quieres participar.", "kind");
  }
  if (!firstName) return invalid("Indica tu nombre.", "firstName");
  if (!lastName) return invalid("Indica tus apellidos.", "lastName");
  if (!isEmail(email)) {
    return invalid("Indica un correo electrónico válido.", "email");
  }
  if (!isPhone(phone)) return invalid("Indica un teléfono válido.", "phone");
  if (!municipality) {
    return invalid("Indica tu municipio o diputación.", "municipality");
  }
  if (!/^\d{5}$/.test(postalCode)) {
    return invalid("Indica un código postal de cinco cifras.", "postalCode");
  }
  if (fieldValue(payload, "privacyAccepted") !== true) {
    return invalid(
      "Necesitamos tu autorización para guardar los datos y contactarte.",
      "privacyAccepted",
    );
  }
  if (kind === "neighbor" && !participantProfiles.has(participantProfile)) {
    return invalid(
      "Indica si participaría un hogar o un negocio.",
      "participantProfile",
    );
  }
  if (kind === "roof" && !roofSurfaceRanges.has(roofSurfaceRange)) {
    return invalid(
      "Indica la superficie aproximada de la cubierta.",
      "roofSurfaceRange",
    );
  }
  if (kind === "roof" && !roofRelationships.has(roofRelationship)) {
    return invalid("Indica tu relación con la cubierta.", "roofRelationship");
  }

  return {
    ok: true,
    value: {
      kind,
      firstName,
      lastName,
      email,
      phone,
      municipality,
      postalCode,
      address,
      participantProfile: kind === "neighbor" ? participantProfile : "",
      roofSurfaceRange: kind === "roof" ? roofSurfaceRange : "",
      roofRelationship: kind === "roof" ? roofRelationship : "",
      message,
      consentVersion: "2026-07-31",
      source: "manganafer-landing",
      status: "nuevo",
    },
  };
}

async function readRequestBody(
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
    // An errored ReadableStream is already closed by the platform. Releasing
    // this reader in finally is the only applicable cleanup; cancelling it
    // would reject and cannot release any additional request resource.
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

function badRequest(error: string, field?: string): Response {
  return Response.json({ ok: false, error, field }, { status: 400 });
}

function payloadTooLarge(): Response {
  return Response.json(
    { ok: false, error: "La solicitud es demasiado grande." },
    { status: 413 },
  );
}

/**
 * Handles the public Manganáfer form using only explicit storage dependencies.
 * The null JSON root intentionally preserves the pinned Worker’s inherited 500
 * empty response; it is observable compatibility, not validation guidance.
 */
export async function handleInterestRequest<Database>(
  request: Request,
  dependencies: InterestRequestDependencies<Database>,
): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maximumRequestBytes) return payloadTooLarge();

  const body = await readRequestBody(request);
  if (body.kind === "too-large") return payloadTooLarge();
  if (body.kind === "invalid") {
    return badRequest("No hemos podido leer el formulario.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.value) as unknown;
  } catch {
    return badRequest("No hemos podido leer el formulario.");
  }

  if (payload === null) return new Response(null, { status: 500 });
  if (text(fieldValue(payload, "website"), 200)) {
    return Response.json({ ok: true }, { status: 201 });
  }

  const validation = validateInterestPayload(payload);
  if (!validation.ok) return badRequest(validation.error, validation.field);

  try {
    await dependencies.ensureStorage(dependencies.db);
    const interest = await dependencies.persistInterest(
      dependencies.db,
      validation.value,
    );
    return Response.json(
      { ok: true, id: interest.id, kind: interest.kind },
      { status: 201 },
    );
  } catch {
    return Response.json(
      {
        ok: false,
        error:
          "No hemos podido guardar tu solicitud. Inténtalo de nuevo en unos minutos.",
      },
      { status: 500 },
    );
  }
}
