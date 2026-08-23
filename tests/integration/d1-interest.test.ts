import assert from "node:assert/strict";
import test from "node:test";

import { withLocalD1Worker } from "../helpers/wrangler-local.ts";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    kind: "neighbor",
    firstName: "Registro sintético",
    lastName: "Prueba aislada",
    email: "d1-synthetic@example.test",
    phone: "600000000",
    municipality: "Municipio sintético",
    postalCode: "30385",
    address: "Zona sintética",
    participantProfile: "hogar",
    message: "Solicitud sintética de integración.",
    privacyAccepted: true,
    ...overrides,
  };
}

test("uses isolated local D1 migrations and upserts one Manganáfer interest per email and kind", async () => {
  await withLocalD1Worker(async ({ fetch, query }) => {
    const first = await fetch("/api/manganafer-interest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload()),
    });
    assert.equal(first.status, 201);
    const firstBody = (await first.json()) as { id: number; kind: string };
    assert.equal(firstBody.kind, "neighbor");

    const second = await fetch("/api/manganafer-interest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload({ firstName: "Actualizado sintético" })),
    });
    assert.equal(second.status, 201);
    const secondBody = (await second.json()) as { id: number; kind: string };
    assert.equal(secondBody.id, firstBody.id);
    assert.equal(secondBody.kind, "neighbor");

    const rows = await query(
      "SELECT COUNT(*) AS total, first_name AS firstName, consent_version AS consentVersion, source FROM manganafer_interests",
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.total), 1);
    assert.equal(rows[0]?.firstName, "Actualizado sintético");
    assert.equal(rows[0]?.consentVersion, "2026-07-31");
    assert.equal(rows[0]?.source, "manganafer-landing");
  });
});

test("creates the canonical D1 schema from the endpoint when local storage starts empty", async () => {
  await withLocalD1Worker(
    async ({ fetch, query }) => {
      const response = await fetch("/api/manganafer-interest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          payload({
            kind: "roof",
            email: "empty-d1@example.test",
            roofSurfaceRange: "500-1000",
            roofRelationship: "propietario",
            participantProfile: undefined,
          }),
        ),
      });
      assert.equal(response.status, 201);

      const tables = await query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manganafer_interests'",
      );
      assert.deepEqual(
        tables.map((table) => table.name),
        ["manganafer_interests"],
      );
      const indexes = await query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'manganafer_interests' ORDER BY name",
      );
      assert.deepEqual(
        indexes.map((index) => index.name),
        [
          "manganafer_interests_created_at_idx",
          "manganafer_interests_email_kind_unique",
          "manganafer_interests_kind_idx",
        ],
      );
    },
    { applyMigrations: false },
  );
});
