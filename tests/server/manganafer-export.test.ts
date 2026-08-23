import assert from "node:assert/strict";
import test from "node:test";

import {
  handleManganaferInterestExport,
  toInterestCsv,
  type ManganaferInterestExportRow,
} from "../../src/lib/manganafer/csv.ts";

const allowedIdentity = {
  displayName: "Administración sintética",
  email: "admin-synthetic@example.test",
  fullName: "Administración sintética",
};

const csvLabels = [
  "Fecha",
  "Tipo",
  "Nombre",
  "Apellidos",
  "Email",
  "Teléfono",
  "Municipio o diputación",
  "Código postal",
  "Dirección o zona",
  "Perfil participante",
  "Superficie cubierta",
  "Relación con cubierta",
  "Mensaje",
  "Estado",
  "Consentimiento",
] as const;

function interest(
  overrides: Partial<ManganaferInterestExportRow> = {},
): ManganaferInterestExportRow {
  return {
    id: 1,
    createdAt: "2026-08-23 10:00:00",
    kind: "neighbor",
    firstName: "Registro",
    lastName: "Sintético",
    email: "record-synthetic@example.test",
    phone: "600000000",
    municipality: "Municipio sintético",
    postalCode: "30385",
    address: "Zona sintética",
    participantProfile: "hogar",
    roofSurfaceRange: "",
    roofRelationship: "",
    message: "Solicitud sintética",
    status: "nuevo",
    consentVersion: "2026-07-31",
    ...overrides,
  };
}

test("fails closed before loading Manganáfer interest rows", async () => {
  for (const [identity, env, expectedStatus, expectedError] of [
    [null, {}, 401, "Necesitas identificarte."],
    [allowedIdentity, {}, 403, "Acceso no autorizado."],
    [
      allowedIdentity,
      { MANGANAFER_ALLOWED_EMAILS: "other-synthetic@example.test" },
      403,
      "Acceso no autorizado.",
    ],
  ] as const) {
    let reads = 0;
    const response = await handleManganaferInterestExport({
      identity,
      env,
      listInterests: async () => {
        reads += 1;
        return [];
      },
    });

    assert.equal(response.status, expectedStatus);
    assert.deepEqual(await response.json(), { error: expectedError });
    assert.equal(reads, 0);
  }
});

test("serializes the source CSV with BOM, CRLF, fifteen columns, and quotes", () => {
  const csv = toInterestCsv([
    interest({ message: 'dice "hola" desde una solicitud sintética' }),
  ]);

  assert.equal(csv.startsWith("\uFEFF"), true);
  const [header, row, ...remaining] = csv.slice(1).split("\r\n");
  assert.deepEqual(remaining, []);
  assert.equal(header.split(",").length, 15);
  assert.equal(header, csvLabels.map((label) => `"${label}"`).join(","));
  assert.match(row, /"dice ""hola"" desde una solicitud sintética"/);
});

test("returns an attachment with source headers after an allowed D1 read", async () => {
  const rows = [interest()];
  let reads = 0;
  const response = await handleManganaferInterestExport({
    identity: allowedIdentity,
    env: { MANGANAFER_ALLOWED_EMAILS: allowedIdentity.email },
    listInterests: async () => {
      reads += 1;
      return rows;
    },
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="manganafer-interesados-2026-08-23.csv"',
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(reads, 1);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(
    new TextDecoder().decode(bytes.slice(3)),
    toInterestCsv(rows).slice(1),
  );
});
