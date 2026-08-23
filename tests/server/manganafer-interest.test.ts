import assert from "node:assert/strict";
import test from "node:test";

import {
  handleInterestRequest,
  validateInterestPayload,
} from "../../src/lib/manganafer/interest.ts";

const interestPath = "https://example.test/api/manganafer-interest";

function validNeighbor(overrides: Record<string, unknown> = {}) {
  return {
    kind: "neighbor",
    firstName: "Nombre sintético",
    lastName: "Apellidos sintéticos",
    email: "persona-sintetica@example.test",
    phone: "600000000",
    municipality: "Municipio sintético",
    postalCode: "30385",
    address: "Zona sintética",
    participantProfile: "hogar",
    message: "Consulta sintética.",
    privacyAccepted: true,
    ...overrides,
  };
}

function validRoof(overrides: Record<string, unknown> = {}) {
  return {
    kind: "roof",
    firstName: "Nombre sintético",
    lastName: "Apellidos sintéticos",
    email: "cubierta-sintetica@example.test",
    phone: "600000001",
    municipality: "Municipio sintético",
    postalCode: "30385",
    roofSurfaceRange: "500-1000",
    roofRelationship: "propietario",
    privacyAccepted: true,
    ...overrides,
  };
}

function jsonRequest(payload: unknown, headers: HeadersInit = {}) {
  return new Request(interestPath, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

function malformedJsonRequest() {
  return new Request(interestPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
}

function createDependencies(overrides: Record<string, unknown> = {}) {
  let storageCalls = 0;
  let persistenceCalls = 0;
  let savedInterest: unknown;

  return {
    dependencies: {
      db: {},
      ensureStorage: async () => {
        storageCalls += 1;
      },
      persistInterest: async (_db: unknown, interest: unknown) => {
        persistenceCalls += 1;
        savedInterest = interest;
        return { id: 41, kind: "neighbor" as const };
      },
      ...overrides,
    },
    calls: () => ({ storageCalls, persistenceCalls, savedInterest }),
  };
}

function assertValidationField(payload: unknown, field: string, error: string) {
  const result = validateInterestPayload(payload);
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("Expected validation to fail");
  assert.equal(result.field, field);
  assert.equal(result.error, error);
}

test("validates every required Manganáfer interest field and kind-specific choice", () => {
  for (const [payload, field, error] of [
    [{}, "kind", "Elige cómo quieres participar."],
    [{ kind: "other" }, "kind", "Elige cómo quieres participar."],
    [{ kind: "neighbor" }, "firstName", "Indica tu nombre."],
    [validNeighbor({ firstName: 42 }), "firstName", "Indica tu nombre."],
    [validNeighbor({ lastName: [] }), "lastName", "Indica tus apellidos."],
    [
      validNeighbor({ email: "not-an-email" }),
      "email",
      "Indica un correo electrónico válido.",
    ],
    [validNeighbor({ phone: "123" }), "phone", "Indica un teléfono válido."],
    [
      validNeighbor({ municipality: false }),
      "municipality",
      "Indica tu municipio o diputación.",
    ],
    [
      validNeighbor({ postalCode: "3038" }),
      "postalCode",
      "Indica un código postal de cinco cifras.",
    ],
    [
      validNeighbor({ privacyAccepted: "true" }),
      "privacyAccepted",
      "Necesitamos tu autorización para guardar los datos y contactarte.",
    ],
    [
      validNeighbor({ participantProfile: "invalid" }),
      "participantProfile",
      "Indica si participaría un hogar o un negocio.",
    ],
    [
      validRoof({ roofSurfaceRange: "invalid" }),
      "roofSurfaceRange",
      "Indica la superficie aproximada de la cubierta.",
    ],
    [
      validRoof({ roofRelationship: "invalid" }),
      "roofRelationship",
      "Indica tu relación con la cubierta.",
    ],
  ] as const) {
    assertValidationField(payload, field, error);
  }
});

test("treats arrays and primitive JSON roots as factual kind failures", () => {
  for (const payload of [[], "texto", 42, true]) {
    assertValidationField(payload, "kind", "Elige cómo quieres participar.");
  }
});

test("trims and bounds source text fields while preserving explicit persistence defaults", () => {
  const result = validateInterestPayload(
    validNeighbor({
      firstName: `  ${"N".repeat(96)}  `,
      lastName: `  ${"A".repeat(140)}  `,
      phone: ` ${"6".repeat(44)} `,
      municipality: `  ${"M".repeat(132)}  `,
      postalCode: "30385-extra",
      address: `  ${"Z".repeat(252)}  `,
      message: `  ${"m".repeat(1_220)}  `,
      email: "PERSONA-SINTETICA@EXAMPLE.TEST",
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("Expected a valid neighbor interest");
  assert.equal(result.value.firstName.length, 80);
  assert.equal(result.value.lastName.length, 120);
  assert.equal(result.value.phone.length, 40);
  assert.equal(result.value.municipality.length, 120);
  assert.equal(result.value.postalCode, "30385");
  assert.equal(result.value.address.length, 240);
  assert.equal(result.value.message.length, 1_200);
  assert.equal(result.value.email, "persona-sintetica@example.test");
  assert.equal(result.value.consentVersion, "2026-07-31");
  assert.equal(result.value.source, "manganafer-landing");
});

test("rejects the declared Content-Length limit before touching D1", async () => {
  const fixture = createDependencies();
  const response = await handleInterestRequest(
    jsonRequest(validNeighbor(), { "content-length": "24001" }),
    fixture.dependencies,
  );

  assert.equal(response.status, 413);
  assert.deepEqual(fixture.calls(), {
    storageCalls: 0,
    persistenceCalls: 0,
    savedInterest: undefined,
  });
});

test("rejects an actual oversized body when Content-Length is absent", async () => {
  const fixture = createDependencies();
  const response = await handleInterestRequest(
    jsonRequest(validNeighbor({ message: "m".repeat(24_100) })),
    fixture.dependencies,
  );

  assert.equal(response.status, 413);
  assert.deepEqual(fixture.calls(), {
    storageCalls: 0,
    persistenceCalls: 0,
    savedInterest: undefined,
  });
});

test("returns source-faithful invalid JSON and null-root responses without touching D1", async () => {
  const malformed = createDependencies();
  const malformedResponse = await handleInterestRequest(
    malformedJsonRequest(),
    malformed.dependencies,
  );
  assert.equal(malformedResponse.status, 400);
  assert.deepEqual(await malformedResponse.json(), {
    ok: false,
    error: "No hemos podido leer el formulario.",
  });
  assert.equal(malformed.calls().storageCalls, 0);

  const nullRoot = createDependencies();
  const nullResponse = await handleInterestRequest(
    jsonRequest(null),
    nullRoot.dependencies,
  );
  assert.equal(nullResponse.status, 500);
  assert.equal(await nullResponse.text(), "");
  assert.equal(nullRoot.calls().storageCalls, 0);
});

test("treats an errored request stream as invalid JSON without touching D1", async () => {
  const fixture = createDependencies();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("synthetic request stream failure"));
    },
  });
  const response = await handleInterestRequest(
    new Request(interestPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      // Node requires this for a streaming request body.
      duplex: "half",
    } as RequestInit),
    fixture.dependencies,
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "No hemos podido leer el formulario.",
  });
  assert.equal(fixture.calls().storageCalls, 0);
  assert.equal(fixture.calls().persistenceCalls, 0);
});

test("returns 201 for a honeypot submission without initializing or persisting D1", async () => {
  const fixture = createDependencies();
  const response = await handleInterestRequest(
    jsonRequest(validNeighbor({ website: "https://bot.invalid" })),
    fixture.dependencies,
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(fixture.calls(), {
    storageCalls: 0,
    persistenceCalls: 0,
    savedInterest: undefined,
  });
});

test("persists normalized interest data and returns only its public id and kind", async () => {
  const fixture = createDependencies();
  const response = await handleInterestRequest(
    jsonRequest(validNeighbor({ email: "PERSONA-SINTETICA@EXAMPLE.TEST" })),
    fixture.dependencies,
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    ok: true,
    id: 41,
    kind: "neighbor",
  });
  assert.equal(fixture.calls().storageCalls, 1);
  assert.equal(fixture.calls().persistenceCalls, 1);
  assert.match(
    JSON.stringify(fixture.calls().savedInterest),
    /"email":"persona-sintetica@example\.test"/,
  );
  assert.match(
    JSON.stringify(fixture.calls().savedInterest),
    /"consentVersion":"2026-07-31"/,
  );
  assert.match(
    JSON.stringify(fixture.calls().savedInterest),
    /"source":"manganafer-landing"/,
  );
});

test("keeps database failures generic and does not expose the persistence error", async () => {
  const fixture = createDependencies({
    persistInterest: async () => {
      throw new Error("synthetic database detail");
    },
  });
  const response = await handleInterestRequest(
    jsonRequest(validNeighbor()),
    fixture.dependencies,
  );

  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: false,
    error:
      "No hemos podido guardar tu solicitud. Inténtalo de nuevo en unos minutos.",
  });
  assert.doesNotMatch(JSON.stringify(body), /synthetic database detail/);
});
