import assert from "node:assert/strict";
import test from "node:test";

import { readExistingRouteMatrix } from "../../scripts/lib/route-inventory.ts";
import { verifyServer } from "../../scripts/verify-server.ts";

function matrixEntry(
  kind: "api" | "private-page",
  path: string,
  status = "verified",
) {
  return {
    kind,
    path,
    sourceFile: "app/fixture.ts",
    fixtureId: null,
    expectedStatus: 200,
    expectedLocation: null,
    privateArea: kind === "private-page" ? "equipo" : null,
    visualTemplate: null,
    status,
  };
}

const expectedServerMatrix = [
  matrixEntry("api", "/api/manganafer-interest"),
  matrixEntry("api", "/api/manganafer-interest/export"),
  matrixEntry("api", "/api/manganafer-quote"),
  matrixEntry("private-page", "/guia-equipo"),
  matrixEntry("private-page", "/guia-equipo-nueva-web-comunidad-solar.md"),
  matrixEntry("private-page", "/manganafer/interesados"),
  matrixEntry("private-page", "/socios"),
];

const expectedApiContracts = [
  "api:/api/manganafer-interest/export|GET|anonymous|default",
  "api:/api/manganafer-interest/export|GET|denied|default",
  "api:/api/manganafer-interest/export|GET|unconfigured|default",
  "api:/api/manganafer-interest|POST|anonymous|invalid-form",
  "api:/api/manganafer-quote|POST|anonymous|invalid-cups",
  "api:/api/manganafer-quote|POST|anonymous|unconfigured",
].map((routeKey) => ({
  routeKey,
  bodyCapture: "captured" as const,
  bodyComparison: "exact" as const,
}));

const expectedPrivateContracts = expectedServerMatrix
  .filter((entry) => entry.kind === "private-page")
  .map((entry) => ({
    routeKey: `private-page:${entry.path}|GET|anonymous|default`,
    bodyCapture: "captured" as const,
    bodyComparison: "exact" as const,
  }));

test("classifies exactly the Phase 3 API and private routes, requiring verified rows and captured API evidence", async () => {
  const result = await verifyServer({
    readMatrix: async () => expectedServerMatrix,
    readBaseline: async () => ({
      contracts: [...expectedApiContracts, ...expectedPrivateContracts],
    }),
  });
  assert.deepEqual(result, {
    apiContracts: 6,
    apiRoutes: 3,
    privateRoutes: 4,
    serverRoutes: 7,
  });

  await assert.rejects(
    verifyServer({
      readMatrix: async () => [
        ...expectedServerMatrix,
        { ...matrixEntry("api", "/api/unknown"), kind: "future" },
      ],
      readBaseline: async () => ({
        contracts: [...expectedApiContracts, ...expectedPrivateContracts],
      }),
    }),
    /tipo de ruta.*future/i,
  );
  await assert.rejects(
    verifyServer({
      readMatrix: async () => [
        ...expectedServerMatrix.slice(0, -1),
        matrixEntry("private-page", "/socios", "pending"),
      ],
      readBaseline: async () => ({
        contracts: [...expectedApiContracts, ...expectedPrivateContracts],
      }),
    }),
    /no verificada/i,
  );
  await assert.rejects(
    verifyServer({
      readMatrix: async () => expectedServerMatrix,
      readBaseline: async () => ({
        contracts: [
          ...expectedApiContracts.slice(1),
          ...expectedPrivateContracts,
        ],
      }),
    }),
    /evidencia capturada/i,
  );
  await assert.rejects(
    verifyServer({
      readMatrix: async () => [
        ...expectedServerMatrix,
        matrixEntry("api", "/api/manganafer-interest"),
      ],
      readBaseline: async () => ({
        contracts: [...expectedApiContracts, ...expectedPrivateContracts],
      }),
    }),
    /rutas server no coinciden/i,
  );
});

test("leaves no pending Phase 3 server route before the closure", async () => {
  const matrix = await readExistingRouteMatrix();
  await assert.doesNotReject(verifyServer({ readMatrix: async () => matrix }));
});

test("rejects the local D1 UUID from a publisher Cloudflare config", async () => {
  const { prepareCloudflareConfig } =
    await import("../../scripts/prepare-cloudflare-config.ts");

  await assert.rejects(
    prepareCloudflareConfig("wrangler.jsonc"),
    /database_id de producci[oó]n o preview/i,
  );
});
