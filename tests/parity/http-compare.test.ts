import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type HttpBaseline,
  type HttpContract,
} from "../../scripts/capture-http-baseline.ts";
import type {
  RouteMatrixEntry,
  SourceManifest,
} from "../../scripts/lib/route-inventory.ts";
import {
  applyFoundationMatrixResults,
  applyPublicMatrixResults,
  compareHttpContract,
  parseHttpParityArguments,
  resolveDeploymentTopology,
  runHttpParity,
  runFoundationParity,
  runPublicParity,
  runPublicAssetParity,
  selectFoundationContracts,
  selectPublicContracts,
  writeMatrixToDisk,
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
    bodyComparison: "exact",
    bodySha256: "a".repeat(64),
    normalizedHtmlPath: null,
    htmlSemantics: null,
    bodyText: "Esta página ya no forma parte del catálogo de Comunidad Solar.",
    bodyJsonShape: null,
    ...overrides,
  };
}

type BodyComparison = "exact" | "semantic";

interface HtmlSemanticsFixture {
  canonical: string[];
  robots: string[];
  normalizedText: string;
}

type HtmlContractFixture = Extract<HttpContract, { bodyCapture: "captured" }> & {
  bodyComparison: BodyComparison;
  htmlSemantics: HtmlSemanticsFixture;
};

function htmlContract(
  overrides: Partial<HtmlContractFixture> = {},
): HtmlContractFixture {
  return {
    ...capturedContract({
      routeKey: "page:/|GET|anonymous|default",
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      bodyText: null,
    }),
    bodyComparison: "exact",
    htmlSemantics: {
      canonical: ["https://comunidadsolar.es/"],
      robots: ["index,follow"],
      normalizedText: "Comunidad Solar",
    },
    ...overrides,
  };
}

function baselineFixture(contracts: HttpContract[]): HttpBaseline {
  return {
    schemaVersion: 2,
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

test("reports body mode and each public HTML semantic field", () => {
  const expected = htmlContract();
  const actual = htmlContract({
    bodyComparison: "semantic",
    bodySha256: "b".repeat(64),
    htmlSemantics: {
      canonical: ["https://comunidadsolar.es/nosotros"],
      robots: ["noindex"],
      normalizedText: "Comunidad Solar cooperativa",
    },
  });

  assert.deepEqual(
    compareHttpContract(expected as HttpContract, actual as HttpContract),
    [
      {
        routeKey: "page:/|GET|anonymous|default",
        field: "bodyComparison",
        expected: "exact",
        actual: "semantic",
      },
      {
        routeKey: "page:/|GET|anonymous|default",
        field: "bodySha256",
        expected: "a".repeat(64),
        actual: "b".repeat(64),
      },
      {
        routeKey: "page:/|GET|anonymous|default",
        field: "canonical",
        expected: ["https://comunidadsolar.es/"],
        actual: ["https://comunidadsolar.es/nosotros"],
      },
      {
        routeKey: "page:/|GET|anonymous|default",
        field: "robots",
        expected: ["index,follow"],
        actual: ["noindex"],
      },
      {
        routeKey: "page:/|GET|anonymous|default",
        field: "normalizedText",
        expected: "Comunidad Solar",
        actual: "Comunidad Solar cooperativa",
      },
    ],
  );
});

test("does not diff an exact body hash when the expected body mode is semantic", () => {
  const expected = htmlContract({ bodyComparison: "semantic" });
  const actual = htmlContract({
    bodyComparison: "exact",
    bodySha256: "b".repeat(64),
  });

  assert.deepEqual(
    compareHttpContract(expected as HttpContract, actual as HttpContract),
    [
      {
        routeKey: "page:/|GET|anonymous|default",
        field: "bodyComparison",
        expected: "semantic",
        actual: "exact",
      },
    ],
  );
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
    bodyComparison: "exact",
    bodySha256: "b".repeat(64),
    normalizedHtmlPath: ".artifacts/http-baseline/private-response.html",
    htmlSemantics: null,
    bodyText: "contenido privado que nunca debe aparecer en un diff",
    bodyJsonShape: null,
  };
  Object.assign(actual as object, {
    bodyComparison: "exact",
    htmlSemantics: {
      canonical: ["https://private.example.test/"],
      robots: ["noindex"],
      normalizedText: "contenido privado que nunca debe aparecer en un diff",
    },
  });

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
  assert.equal(JSON.stringify(diffs).includes("private.example.test"), false);
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

test("selects and promotes only declared Phase 2 public HTTP contracts", async () => {
  const page = capturedContract({
    routeKey: "page:/aviso-legal|GET|anonymous|default",
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
    bodySha256: createHash("sha256").update("legal public").digest("hex"),
    bodyText: null,
  });
  const redirect = capturedContract({
    routeKey: "redirect:/mision|GET|anonymous|default",
    status: 308,
  });
  const gone = capturedContract();
  const privatePage: HttpContract = {
    routeKey: "private-page:/socios|GET|allowed|default",
    status: 200,
    headers: {},
    bodyCapture: "suppressed-private-success",
  };
  const api = capturedContract({
    routeKey: "api:/api/manganafer-interest|GET|anonymous|default",
    status: 200,
  });
  const deferred = capturedContract({
    routeKey:
      "page:/comunidades-energeticas/manganafer|GET|anonymous|default",
    status: 200,
  });
  const baseline = baselineFixture([page, redirect, gone, privatePage, api, deferred]);
  const matrix = [
    matrixEntry("page", "/aviso-legal"),
    matrixEntry("redirect", "/mision"),
    matrixEntry("gone", "/subvenciones"),
    matrixEntry("private-page", "/socios"),
    matrixEntry("api", "/api/manganafer-interest"),
    matrixEntry("page", "/comunidades-energeticas/manganafer"),
    matrixEntry("asset", "/media/frozen.png"),
  ];

  assert.deepEqual(
    selectPublicContracts(baseline, matrix).map((contract) => contract.routeKey),
    [page.routeKey, redirect.routeKey, gone.routeKey],
  );
  assert.deepEqual(
    applyPublicMatrixResults(
      matrix,
      new Set(["page:/aviso-legal", "redirect:/mision", "gone:/subvenciones"]),
    ).map((entry) => [entry.kind, entry.path, entry.status]),
    [
      ["page", "/aviso-legal", "verified"],
      ["redirect", "/mision", "verified"],
      ["gone", "/subvenciones", "verified"],
      ["private-page", "/socios", "pending"],
      ["api", "/api/manganafer-interest", "pending"],
      ["page", "/comunidades-energeticas/manganafer", "pending"],
      ["asset", "/media/frozen.png", "pending"],
    ],
  );
  assert.deepEqual(parseHttpParityArguments(["--scope", "public"]), {
    scope: "public",
  });

  const root = await mkdtemp(join(tmpdir(), "parity-http-public-contract-"));
  try {
    await mkdir(join(root, "parity"), { recursive: true });
    await writeFile(join(root, "parity", "source-manifest.json"), '{"assets":[]}');
    let written: RouteMatrixEntry[] | undefined;
    const result = await runHttpParity(
      { scope: "public", root },
      {
        build: async () => {},
        resolveTopology: async () => ({
          deployConfigPath: "/fixture/.wrangler/deploy/config.json",
          wranglerConfigPath: "/fixture/dist/server/wrangler.json",
          entryPath: "/fixture/dist/server/entry.mjs",
        }),
        readBaseline: async () => baselineFixture([page]),
        readMatrix: async () => [matrix[0]],
        startRuntime: async () => ({
          fetch: async () =>
            new Response("legal public", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            }),
          dispose: async () => {},
        }),
        writeMatrix: async (entries) => {
          written = entries;
        },
      },
    );
    assert.equal(result.scope, "public");
    assert.equal(result.checkedContracts, 1);
    assert.equal(written?.[0].status, "verified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifies Phase 2 public assets against manifest hash, bytes, and media type", async () => {
  const body = Buffer.from("frozen asset bytes", "utf8");
  const matrix = [
    {
      ...matrixEntry("asset", "/media/frozen.png"),
      sourceFile: "public/media/frozen.png",
    },
    matrixEntry("private-page", "/socios"),
    matrixEntry("page", "/comunidades-energeticas/manganafer"),
  ];
  const manifest = {
    assets: [
      {
        path: "public/media/frozen.png",
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: body.byteLength,
        mediaType: "image/png",
      },
    ],
  } as Pick<SourceManifest, "assets">;

  const matched = await runPublicAssetParity(matrix, manifest, {
    fetch: async () =>
      new Response(body, { headers: { "content-type": "image/png" } }),
    dispose: async () => {},
  });
  assert.equal(matched.checkedAssets, 1);
  assert.deepEqual(matched.diffs, []);
  assert.deepEqual([...matched.verifiedRouteKeys], ["asset:/media/frozen.png"]);

  const mismatched = await runPublicAssetParity(matrix, manifest, {
    fetch: async () =>
      new Response("wrong", {
        headers: { "content-type": "application/octet-stream" },
      }),
    dispose: async () => {},
  });
  assert.deepEqual(
    mismatched.diffs.map((diff) => diff.field),
    ["bytes", "sha256", "mediaType"],
  );
  assert.deepEqual([...mismatched.verifiedRouteKeys], []);

  await assert.rejects(
    runPublicAssetParity(
      matrix,
      {
        assets: [
          ...manifest.assets,
          {
            path: "public/media/unmapped.webp",
            sha256: "f".repeat(64),
            bytes: 1,
            mediaType: "image/webp",
          },
        ],
      },
      {
        fetch: async () => new Response("unused"),
        dispose: async () => {},
      },
    ),
    /sin fila de matriz/i,
  );
  await assert.rejects(
    runPublicAssetParity(
      [{ ...matrix[0], expectedStatus: 404 }, ...matrix.slice(1)],
      manifest,
      {
        fetch: async () => new Response("unused"),
        dispose: async () => {},
      },
    ),
    /status 200/i,
  );
});

test("fails closed when a non-private public HTTP contract has no matrix row", () => {
  assert.throws(
    () =>
      selectPublicContracts(
        baselineFixture([
          capturedContract({
            routeKey: "page:/not-in-matrix|GET|anonymous|default",
            status: 200,
          }),
        ]),
        [],
      ),
    /no declarad[oa].*matriz/i,
  );
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

test("disposes a public runtime when its asset manifest cannot be read", async () => {
  const root = await mkdtemp(join(tmpdir(), "parity-http-public-manifest-"));
  let disposed = 0;
  try {
    await assert.rejects(
      runPublicParity(
        baselineFixture([]),
        [],
        {
          fetch: async () => new Response("unused"),
          dispose: async () => {
            disposed += 1;
          },
        },
        { root },
      ),
      /source-manifest\.json/,
    );
    assert.equal(disposed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves semantic expected mode through injected candidate capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "parity-http-semantic-candidate-"));
  let disposed = 0;
  const expected = htmlContract({
    routeKey: "gone:/subvenciones|GET|anonymous|default",
    status: 410,
    bodyComparison: "semantic",
    bodySha256: "f".repeat(64),
  });

  try {
    const result = await runFoundationParity(
      { contracts: [expected] },
      {
        fetch: async () =>
          new Response(
            [
              "<!doctype html>",
              '<link rel="canonical" href="https://comunidadsolar.es/">',
              '<meta name="robots" content="index,follow">',
              "<main>Comunidad Solar</main>",
            ].join(""),
            {
              status: 410,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          ),
        dispose: async () => {
          disposed += 1;
        },
      },
      { root },
    );

    assert.deepEqual(result.diffs, []);
    assert.equal(result.checkedContracts, 1);
    assert.deepEqual([...result.verifiedRouteKeys], ["gone:/subvenciones"]);
    assert.equal(disposed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("runs routing contracts without promoting the route matrix", async () => {
  const body = "Esta página ya no forma parte del catálogo de Comunidad Solar.";
  const matrix = [matrixEntry("gone", "/subvenciones")];
  let matrixWrites = 0;

  assert.deepEqual(parseHttpParityArguments(["--scope", "routing"]), {
    scope: "routing",
  });

  const result = await runHttpParity(
    { scope: "routing", root: process.cwd() },
    {
      build: async () => {},
      resolveTopology: async () => ({
        deployConfigPath: "/fixture/.wrangler/deploy/config.json",
        wranglerConfigPath: "/fixture/dist/server/wrangler.json",
        entryPath: "/fixture/dist/server/entry.mjs",
      }),
      readBaseline: async () =>
        baselineFixture([
          capturedContract({
            bodySha256: createHash("sha256").update(body).digest("hex"),
          }),
        ]),
      readMatrix: async () => matrix,
      startRuntime: async () => ({
        fetch: async () =>
          new Response(body, {
            status: 410,
            headers: {
              "cache-control": "public, max-age=3600",
              "content-type": "text/plain; charset=utf-8",
              "x-robots-tag": "noindex",
            },
          }),
        dispose: async () => {},
      }),
      writeMatrix: async () => {
        matrixWrites += 1;
      },
    },
  );

  assert.equal(result.scope, "routing");
  assert.equal(result.checkedContracts, 1);
  assert.deepEqual(result.diffs, []);
  assert.equal(result.verifiedRoutes, 0);
  assert.equal(result.pendingRoutes, 1);
  assert.equal(matrixWrites, 0);
});

test("keeps a real matrix unchanged and removes its temp file when rename fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "parity-http-atomic-matrix-"));
  try {
    const parityRoot = join(root, "parity");
    const matrixPath = join(parityRoot, "route-matrix.json");
    const original = `${JSON.stringify([matrixEntry("gone", "/subvenciones")], null, 2)}\n`;
    await mkdir(parityRoot, { recursive: true });
    await writeFile(matrixPath, original);

    let failure: unknown;
    try {
      await runHttpParity(
        { scope: "foundation", root },
        {
          build: async () => {},
          resolveTopology: async () => ({
            deployConfigPath: join(root, ".wrangler", "deploy", "config.json"),
            wranglerConfigPath: join(root, "dist", "server", "wrangler.json"),
            entryPath: join(root, "dist", "server", "entry.mjs"),
          }),
          readBaseline: async () =>
            baselineFixture([
              capturedContract({
                bodySha256:
                  "768adae9570892d48afde2a6c2171d824b3c5a513501e61a9b7c5750f4a685c4",
              }),
            ]),
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
            dispose: async () => {},
          }),
          matrixFileSystem: {
            writeFile: async (path, contents, options) =>
              writeFile(path, contents, options),
            rename: async () => {
              throw new Error("simulated matrix rename failure");
            },
            rm: async (path, options) => rm(path, options),
            randomUUID: () => "matrix-test-uuid",
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof Error);
    assert.match(failure.message, /simulated matrix rename failure/);
    assert.equal(await readFile(matrixPath, "utf8"), original);
    assert.deepEqual(
      (await readdir(parityRoot)).filter((entry) => entry.includes("matrix-test-uuid")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps a real matrix unchanged and removes its temp file when writing fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "parity-http-write-failure-"));
  try {
    const parityRoot = join(root, "parity");
    const matrixPath = join(parityRoot, "route-matrix.json");
    const original = `${JSON.stringify([matrixEntry("gone", "/subvenciones")], null, 2)}\n`;
    await mkdir(parityRoot, { recursive: true });
    await writeFile(matrixPath, original);

    let renameCalls = 0;
    await assert.rejects(
      writeMatrixToDisk(root, [matrixEntry("redirect", "/mision")], {
        writeFile: async (path, contents, options) => {
          await writeFile(path, contents, options);
          throw new Error("simulated matrix write failure");
        },
        rename: async () => {
          renameCalls += 1;
        },
        rm,
        randomUUID: () => "matrix-write-failure-uuid",
      }),
      /simulated matrix write failure/,
    );

    assert.equal(renameCalls, 0);
    assert.equal(await readFile(matrixPath, "utf8"), original);
    assert.deepEqual(
      (await readdir(parityRoot)).filter((entry) =>
        entry.includes("matrix-write-failure-uuid"),
      ),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not overwrite a colliding matrix temp file", async () => {
  const root = await mkdtemp(join(tmpdir(), "parity-http-temp-collision-"));
  try {
    const parityRoot = join(root, "parity");
    const matrixPath = join(parityRoot, "route-matrix.json");
    const temporary = join(parityRoot, ".route-matrix-collision.tmp");
    const original = `${JSON.stringify([matrixEntry("gone", "/subvenciones")], null, 2)}\n`;
    await mkdir(parityRoot, { recursive: true });
    await writeFile(matrixPath, original);
    await writeFile(temporary, "another writer's temporary matrix\n");

    await assert.rejects(
      writeMatrixToDisk(root, [matrixEntry("redirect", "/mision")], {
        writeFile,
        rename: async () => {
          assert.fail("rename must not run after an exclusive-create collision");
        },
        rm,
        randomUUID: () => "collision",
      }),
      (error: Error & { code?: unknown }) => error.code === "EEXIST",
    );

    assert.equal(await readFile(matrixPath, "utf8"), original);
    assert.equal(
      await readFile(temporary, "utf8"),
      "another writer's temporary matrix\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "executes the emitted Astro deploy Worker through its generated Wrangler topology",
  { timeout: 120_000 },
  async () => {
    const result = await runHttpParity({ scope: "foundation" });

    assert.deepEqual(result.diffs, []);
    assert.equal(result.checkedContracts, 225);
    assert.equal(result.verifiedRoutes, 267);
    assert.equal(result.pendingRoutes, 4);
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
