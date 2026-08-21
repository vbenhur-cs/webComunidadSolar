import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  HttpBaseline,
  HttpContract,
} from "../../scripts/capture-http-baseline.ts";
import type { RouteMatrixEntry } from "../../scripts/lib/route-inventory.ts";
import {
  applyFoundationMatrixResults,
  compareHttpContract,
  resolveDeploymentTopology,
  runHttpParity,
  runFoundationParity,
  selectFoundationContracts,
} from "../../scripts/parity-http.ts";

function capturedContract(
  overrides: Partial<Extract<HttpContract, { bodyCapture: "captured" }>> = {},
): Extract<HttpContract, { bodyCapture: "captured" }> {
  return {
    routeKey: "gone:/subvenciones|GET|anonymous|default",
    status: 410,
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "text/plain; charset=utf-8",
      "x-robots-tag": "noindex",
    },
    bodyCapture: "captured",
    bodySha256: "a".repeat(64),
    normalizedHtmlPath: null,
    bodyText: "Esta página ya no forma parte del catálogo de Comunidad Solar.",
    bodyJsonShape: null,
    ...overrides,
  };
}

function baselineFixture(contracts: HttpContract[]): HttpBaseline {
  return {
    schemaVersion: 1,
    source: {
      repository: "../comunidadsolarweb",
      branch: "main",
      commit: "68ea294c54dc5e15e20f470fc421a239927565a8",
    },
    contracts,
    deferred: [
      {
        routeKey: "page:/|GET|anonymous|default",
        deferredToPhase: 2,
        reason: "La home se verifica en la fase 2.",
      },
    ],
  };
}

function matrixEntry(
  kind: RouteMatrixEntry["kind"],
  path: string,
): RouteMatrixEntry {
  return {
    kind,
    path,
    sourceFile: "app/fixture.ts",
    fixtureId: null,
    expectedStatus: kind === "gone" ? 410 : kind === "redirect" ? 308 : 200,
    expectedLocation: null,
    privateArea: null,
    visualTemplate: null,
    status: "pending",
  };
}

test("reports status, selected headers, exact body hash, and public text diffs", () => {
  const expected = capturedContract();
  const actual = capturedContract({
    status: 404,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
    bodySha256: "b".repeat(64),
    bodyText: "Not found",
  });

  assert.deepEqual(compareHttpContract(expected, actual), [
    {
      routeKey: "gone:/subvenciones|GET|anonymous|default",
      field: "status",
      expected: 410,
      actual: 404,
    },
    {
      routeKey: "gone:/subvenciones|GET|anonymous|default",
      field: "headers.cache-control",
      expected: "public, max-age=3600",
      actual: "no-store",
    },
    {
      routeKey: "gone:/subvenciones|GET|anonymous|default",
      field: "headers.x-robots-tag",
      expected: "noindex",
      actual: null,
    },
    {
      routeKey: "gone:/subvenciones|GET|anonymous|default",
      field: "bodySha256",
      expected: "a".repeat(64),
      actual: "b".repeat(64),
    },
    {
      routeKey: "gone:/subvenciones|GET|anonymous|default",
      field: "bodyText",
      expected: "Esta página ya no forma parte del catálogo de Comunidad Solar.",
      actual: "Not found",
    },
  ]);
});

test("does not expose body fields when a private success contract is suppressed", () => {
  const expected: HttpContract = {
    routeKey: "private-page:/socios|GET|allowed|default",
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    bodyCapture: "suppressed-private-success",
  };
  const actual: HttpContract = {
    routeKey: expected.routeKey,
    status: 500,
    headers: expected.headers,
    bodyCapture: "captured",
    bodySha256: "b".repeat(64),
    normalizedHtmlPath: ".artifacts/http-baseline/private-response.html",
    bodyText: "contenido privado que nunca debe aparecer en un diff",
    bodyJsonShape: null,
  };

  const diffs = compareHttpContract(expected, actual);

  assert.deepEqual(diffs, [
    {
      routeKey: "private-page:/socios|GET|allowed|default",
      field: "status",
      expected: 200,
      actual: 500,
    },
    {
      routeKey: "private-page:/socios|GET|allowed|default",
      field: "bodyCapture",
      expected: "suppressed-private-success",
      actual: "captured",
    },
  ]);
  assert.equal(JSON.stringify(diffs).includes("contenido privado"), false);
  assert.equal(JSON.stringify(diffs).includes("private-response.html"), false);
});

test("selects only the approved redirect and gone contract families", () => {
  const redirect = capturedContract({
    routeKey: "redirect:/mision|GET|anonymous|default",
    status: 308,
  });
  const redirectQuery = capturedContract({
    routeKey: "redirect:/mision?utm_source=x|GET|anonymous|redirect-query",
    status: 308,
  });
  const gone = capturedContract();
  const page = capturedContract({ routeKey: "page:/|GET|anonymous|default", status: 200 });
  const privatePage: HttpContract = {
    routeKey: "private-page:/socios|GET|allowed|default",
    status: 200,
    headers: {},
    bodyCapture: "suppressed-private-success",
  };

  assert.deepEqual(
    selectFoundationContracts(baselineFixture([redirect, redirectQuery, gone, page, privatePage])).map(
      (contract) => contract.routeKey,
    ),
    [redirect.routeKey, redirectQuery.routeKey, gone.routeKey],
  );
});

test("marks only foundation routes verified and leaves the home pending", () => {
  const matrix = [
    matrixEntry("page", "/"),
    matrixEntry("redirect", "/mision"),
    matrixEntry("gone", "/subvenciones"),
    matrixEntry("api", "/api/manganafer-interest"),
  ];

  const updated = applyFoundationMatrixResults(
    matrix,
    new Set(["page:/", "redirect:/mision", "gone:/subvenciones"]),
  );

  assert.equal(updated.find((entry) => entry.kind === "page")?.status, "pending");
  assert.equal(
    updated.find((entry) => entry.kind === "redirect")?.status,
    "verified",
  );
  assert.equal(updated.find((entry) => entry.kind === "gone")?.status, "verified");
  assert.equal(updated.find((entry) => entry.kind === "api")?.status, "pending");
});

test("resolves the generated deploy config and its configured entry module", async () => {
  const root = await mkdtemp(join(tmpdir(), "parity-http-topology-"));
  try {
    await mkdir(join(root, ".wrangler", "deploy"), { recursive: true });
    await mkdir(join(root, "dist", "server"), { recursive: true });
    await writeFile(
      join(root, ".wrangler", "deploy", "config.json"),
      JSON.stringify({ configPath: "../../dist/server/wrangler.json" }),
    );
    await writeFile(
      join(root, "dist", "server", "wrangler.json"),
      JSON.stringify({ main: "entry.mjs" }),
    );
    await writeFile(join(root, "dist", "server", "entry.mjs"), "export default {};");

    assert.deepEqual(await resolveDeploymentTopology(root), {
      deployConfigPath: join(root, ".wrangler", "deploy", "config.json"),
      wranglerConfigPath: join(root, "dist", "server", "wrangler.json"),
      entryPath: join(root, "dist", "server", "entry.mjs"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposes a supplied runtime even when a foundation request fails", async () => {
  let disposed = 0;
  const baseline = baselineFixture([capturedContract()]);

  await assert.rejects(
    runFoundationParity(baseline, {
      fetch: async () => {
        throw new Error("fixture worker failed");
      },
      dispose: async () => {
        disposed += 1;
      },
    }),
    /fixture worker failed/,
  );
  assert.equal(disposed, 1);
});

test("builds once and records only proven foundation rows with injected local dependencies", async () => {
  let builds = 0;
  let disposed = 0;
  let written: RouteMatrixEntry[] | undefined;
  const baseline = baselineFixture([
    capturedContract({
      bodySha256:
        "768adae9570892d48afde2a6c2171d824b3c5a513501e61a9b7c5750f4a685c4",
    }),
  ]);
  const matrix = [matrixEntry("page", "/"), matrixEntry("gone", "/subvenciones")];

  const result = await runHttpParity(
    { scope: "foundation", root: process.cwd() },
    {
      build: async () => {
        builds += 1;
      },
      resolveTopology: async () => ({
        deployConfigPath: "/fixture/.wrangler/deploy/config.json",
        wranglerConfigPath: "/fixture/dist/server/wrangler.json",
        entryPath: "/fixture/dist/server/entry.mjs",
      }),
      readBaseline: async () => baseline,
      readMatrix: async () => matrix,
      startRuntime: async () => ({
        fetch: async () =>
          new Response(
            "Esta página ya no forma parte del catálogo de Comunidad Solar.",
            {
              status: 410,
              headers: {
                "cache-control": "public, max-age=3600",
                "content-type": "text/plain; charset=utf-8",
                "x-robots-tag": "noindex",
              },
            },
          ),
        dispose: async () => {
          disposed += 1;
        },
      }),
      writeMatrix: async (entries) => {
        written = entries;
      },
    },
  );

  assert.equal(builds, 1);
  assert.equal(disposed, 1);
  assert.equal(result.checkedContracts, 1);
  assert.equal(result.verifiedRoutes, 1);
  assert.equal(result.pendingRoutes, 1);
  assert.equal(written?.find((entry) => entry.path === "/")?.status, "pending");
  assert.equal(
    written?.find((entry) => entry.path === "/subvenciones")?.status,
    "verified",
  );
});

test(
  "executes the emitted Astro deploy Worker through its generated Wrangler topology",
  { timeout: 120_000 },
  async () => {
    const result = await runHttpParity({ scope: "foundation" });

    assert.deepEqual(result.diffs, []);
    assert.equal(result.checkedContracts, 225);
    assert.equal(result.verifiedRoutes, 122);
    assert.equal(result.pendingRoutes, 149);
    assert.equal(result.runtimeDisposed, true);
    assert.match(
      result.topology.deployConfigPath,
      /\.wrangler[\\/]deploy[\\/]config\.json$/,
    );
    assert.match(result.topology.wranglerConfigPath, /dist[\\/]server[\\/]wrangler\.json$/);
    assert.match(result.topology.entryPath, /dist[\\/]server[\\/]entry\.mjs$/);
    assert.match(await readFile(result.topology.entryPath, "utf8"), /src\/fetch\.ts/);
    assert.match(await readFile(result.topology.entryPath, "utf8"), /routeBeforeAstro/);
    assert.equal(
      JSON.parse(await readFile(result.topology.wranglerConfigPath, "utf8")).main,
      "entry.mjs",
    );
  },
);
