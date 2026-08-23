import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  HttpBaseline,
  HttpContract,
} from "../../scripts/capture-http-baseline.ts";
import type { RouteMatrixEntry } from "../../scripts/lib/route-inventory.ts";
import {
  applyServerMatrixResults,
  parseHttpParityArguments,
  runHttpParity,
  selectServerApiContracts,
} from "../../scripts/parity-http.ts";

function capturedApi(
  routeKey: string,
  body: string,
): Extract<HttpContract, { bodyCapture: "captured" }> {
  return {
    routeKey,
    status: 400,
    headers: { "content-type": "application/json" },
    bodyCapture: "captured",
    bodyComparison: "exact",
    bodySha256: createHash("sha256").update(body).digest("hex"),
    normalizedHtmlPath: null,
    htmlSemantics: null,
    bodyText: null,
    bodyJsonShape: { error: "string", ok: "boolean" },
  };
}

function serverMatrixEntry(
  kind: "api" | "private-page",
  path: string,
): RouteMatrixEntry {
  return {
    kind,
    path,
    sourceFile: "app/fixture.ts",
    fixtureId: null,
    expectedStatus: 200,
    expectedLocation: null,
    privateArea: kind === "private-page" ? "equipo" : null,
    visualTemplate: null,
    status: "pending",
  };
}

function baseline(contracts: HttpContract[]): HttpBaseline {
  return {
    schemaVersion: 2,
    source: {
      repository: "../comunidadsolarweb",
      branch: "main",
      commit: "68ea294c54dc5e15e20f470fc421a239927565a8",
    },
    contracts,
    deferred: [],
  };
}

test("selects only captured API contracts and fails closed for unknown or uncovered server routes", () => {
  const api = capturedApi(
    "api:/api/manganafer-interest|POST|anonymous|invalid-form",
    JSON.stringify({ ok: false, error: "Formulario inválido" }),
  );
  const privatePage: HttpContract = {
    routeKey: "private-page:/guia-equipo|GET|anonymous|default",
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    bodyCapture: "captured",
    bodyComparison: "exact",
    bodySha256: "a".repeat(64),
    normalizedHtmlPath: null,
    htmlSemantics: {
      canonical: [],
      robots: [],
      normalizedText: "Acceso privado",
    },
    bodyText: null,
    bodyJsonShape: null,
  };
  const publicPage = capturedApi(
    "page:/|GET|anonymous|default",
    JSON.stringify({ ok: false, error: "No aplica" }),
  );
  const matrix: RouteMatrixEntry[] = [
    serverMatrixEntry("api", "/api/manganafer-interest"),
    serverMatrixEntry("private-page", "/guia-equipo"),
    {
      ...serverMatrixEntry("api", "/placeholder"),
      kind: "page",
      path: "/",
    },
  ];

  assert.deepEqual(
    selectServerApiContracts(baseline([api, privatePage, publicPage]), matrix).map(
      (contract) => contract.routeKey,
    ),
    [api.routeKey],
  );
  assert.deepEqual(
    applyServerMatrixResults(
      matrix,
      new Set(["api:/api/manganafer-interest", "private-page:/guia-equipo"]),
    ).map((entry) => [entry.kind, entry.path, entry.status]),
    [
      ["api", "/api/manganafer-interest", "verified"],
      ["private-page", "/guia-equipo", "pending"],
      ["page", "/", "pending"],
    ],
  );

  assert.throws(
    () =>
      selectServerApiContracts(baseline([api]), [
        {
          ...serverMatrixEntry("api", "/api/manganafer-interest"),
          kind: "future",
        } as unknown as RouteMatrixEntry,
      ]),
    /tipo de ruta.*future/i,
  );
  assert.throws(
    () => selectServerApiContracts(baseline([api]), []),
    /sin fila de matriz/i,
  );
  assert.throws(
    () =>
      selectServerApiContracts(baseline([api]), [
        serverMatrixEntry("api", "/api/manganafer-interest"),
        serverMatrixEntry("api", "/api/manganafer-quote"),
      ]),
    /api de servidor sin contrato/i,
  );
});

test("server scope keeps pending rows when a captured API contract differs", async () => {
  const expectedBody = JSON.stringify({
    ok: false,
    error: "Formulario inválido",
  });
  const matrix = [serverMatrixEntry("api", "/api/manganafer-interest")];
  let matrixWrites = 0;

  const result = await runHttpParity(
    { scope: "server", root: process.cwd() },
    {
      build: async () => undefined,
      resolveTopology: async () => ({
        deployConfigPath: "/fixture/.wrangler/deploy/config.json",
        wranglerConfigPath: "/fixture/dist/server/wrangler.json",
        entryPath: "/fixture/dist/server/entry.mjs",
      }),
      readBaseline: async () =>
        baseline([
          capturedApi(
            "api:/api/manganafer-interest|POST|anonymous|invalid-form",
            expectedBody,
          ),
        ]),
      readMatrix: async () => matrix,
      startServerRuntime: async () => ({
        fetch: async () =>
          new Response(JSON.stringify({ ok: false, error: "distinto" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        dispose: async () => undefined,
      }),
      writeMatrix: async () => {
        matrixWrites += 1;
      },
    },
  );

  assert.deepEqual(parseHttpParityArguments(["--scope", "server"]), {
    scope: "server",
  });
  assert.equal(result.checkedContracts, 1);
  assert.equal(result.verifiedRoutes, 0);
  assert.equal(result.pendingRoutes, 1);
  assert.equal(result.diffs.length > 0, true);
  assert.equal(matrixWrites, 0);
});
