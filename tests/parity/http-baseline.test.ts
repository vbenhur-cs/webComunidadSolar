import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import type { SourceManifest } from "../../scripts/lib/route-inventory.ts";
import {
  assertHttpBaselineCoverage,
  buildCapturePlan,
  captureHttpContract,
  normalizeHtml,
  serializeHttpBaseline,
  type HttpBaseline,
} from "../../scripts/capture-http-baseline.ts";
import { withTemporarySourceBuild } from "../../scripts/lib/temporary-source-build.ts";

const execFileAsync = promisify(execFile);
const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface SourceFixture {
  root: string;
  commit: string;
  cleanupRoot: string;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  return stdout;
}

async function createSourceRepoFixture(
  files: Record<string, string> = {},
): Promise<SourceFixture> {
  const cleanupRoot = await mkdtemp(join(tmpdir(), "http-baseline-source-"));
  cleanupRoots.push(cleanupRoot);
  const root = join(cleanupRoot, "source");

  await mkdir(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.test"]);
  await git(root, ["config", "user.name", "HTTP baseline fixture"]);
  await writeFile(join(root, "tracked.txt"), "committed source\n");
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "fixture"]);

  return {
    root,
    commit: (await git(root, ["rev-parse", "HEAD"])).trim(),
    cleanupRoot,
  };
}

async function snapshotRepository(root: string): Promise<Record<string, string>> {
  return {
    head: (await git(root, ["rev-parse", "HEAD"])).trim(),
    index: (await git(root, ["write-tree"])).trim(),
    status: await git(root, ["status", "--porcelain=v1"]),
    untracked: await git(root, ["ls-files", "--others", "--exclude-standard"]),
  };
}

function manifestFixture(): SourceManifest {
  return {
    schemaVersion: 1,
    source: {
      repository: "../comunidadsolarweb",
      branch: "main",
      commit: "68ea294c54dc5e15e20f470fc421a239927565a8",
    },
    generatedAt: "2026-08-21T00:00:00.000Z",
    routes: [
      {
        path: "/",
        kind: "page",
        sourceFile: "app/page.tsx",
        fixtureId: null,
        expectedStatus: 200,
        expectedLocation: null,
        privateArea: null,
        visualTemplate: "home",
      },
      {
        path: "/mision",
        kind: "redirect",
        sourceFile: "app/legacy-routes.ts",
        fixtureId: null,
        expectedStatus: 308,
        expectedLocation: "/nosotros#mision",
        privateArea: null,
        visualTemplate: null,
      },
      {
        path: "/subvenciones",
        kind: "gone",
        sourceFile: "app/subvenciones/route.ts",
        fixtureId: null,
        expectedStatus: 410,
        expectedLocation: null,
        privateArea: null,
        visualTemplate: null,
      },
      {
        path: "/socios",
        kind: "private-page",
        sourceFile: "app/socios/page.tsx",
        fixtureId: null,
        expectedStatus: 200,
        expectedLocation: null,
        privateArea: "socios",
        visualTemplate: "socios",
      },
      {
        path: "/manganafer/interesados",
        kind: "private-page",
        sourceFile: "app/manganafer/interesados/page.tsx",
        fixtureId: null,
        expectedStatus: 200,
        expectedLocation: null,
        privateArea: "manganafer",
        visualTemplate: "manganafer-interests",
      },
      {
        path: "/api/manganafer-interest",
        kind: "api",
        sourceFile: "app/api/manganafer-interest/route.ts",
        fixtureId: null,
        expectedStatus: 200,
        expectedLocation: null,
        privateArea: null,
        visualTemplate: null,
      },
      {
        path: "/api/manganafer-interest/export",
        kind: "api",
        sourceFile: "app/api/manganafer-interest/export/route.ts",
        fixtureId: null,
        expectedStatus: 200,
        expectedLocation: null,
        privateArea: "manganafer",
        visualTemplate: null,
      },
      {
        path: "/api/manganafer-quote",
        kind: "api",
        sourceFile: "app/api/manganafer-quote/route.ts",
        fixtureId: null,
        expectedStatus: 200,
        expectedLocation: null,
        privateArea: null,
        visualTemplate: null,
      },
      {
        path: "/favicon.svg",
        kind: "asset",
        sourceFile: "public/favicon.svg",
        fixtureId: null,
        expectedStatus: 200,
        expectedLocation: null,
        privateArea: null,
        visualTemplate: null,
      },
    ],
    sourceFiles: [],
    assets: [],
    wordpressAudit: { total: 122, unclassified: [] },
  };
}

test("builds only inside a temporary git archive", async () => {
  const source = await createSourceRepoFixture();
  const original = await snapshotRepository(source.root);
  const logRoot = join(source.cleanupRoot, "logs");
  let temporaryRoot = "";

  await withTemporarySourceBuild(
    async ({ root }) => {
      temporaryRoot = root;
      assert.notEqual(realpathSync(root), realpathSync(source.root));
      assert.equal(existsSync(join(root, ".git")), false);
      assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "committed source\n");
    },
    {
      sourceRoot: source.root,
      commit: source.commit,
      install: false,
      logRoot,
    },
  );

  assert.equal(existsSync(temporaryRoot), false);
  assert.deepEqual(await snapshotRepository(source.root), original);
});

test("runs a timeout-dependent build only in the temporary archive", async () => {
  const source = await createSourceRepoFixture({
    "package.json": JSON.stringify({
      name: "temporary-build-fixture",
      private: true,
      scripts: {
        build:
          "timeout --signal=TERM --kill-after=1s 5s node -e \"require('node:fs').writeFileSync('built.txt', 'ok')\"",
      },
    }),
  });
  const original = await snapshotRepository(source.root);

  await withTemporarySourceBuild(
    async ({ root }) => {
      assert.equal(await readFile(join(root, "built.txt"), "utf8"), "ok");
    },
    {
      sourceRoot: source.root,
      commit: source.commit,
      install: false,
      build: true,
      logRoot: join(source.cleanupRoot, "logs"),
    },
  );

  assert.equal(existsSync(join(source.root, "built.txt")), false);
  assert.deepEqual(await snapshotRepository(source.root), original);
});

test("provides the archived source index to builds without creating .git", async () => {
  const source = await createSourceRepoFixture({
    "package.json": JSON.stringify({
      name: "temporary-git-fixture",
      private: true,
      scripts: { build: "git ls-files --cached > indexed.txt" },
    }),
  });

  await withTemporarySourceBuild(
    async ({ root }) => {
      assert.equal(existsSync(join(root, ".git")), false);
      assert.equal(
        await readFile(join(root, "indexed.txt"), "utf8"),
        "package.json\ntracked.txt\n",
      );
    },
    {
      sourceRoot: source.root,
      commit: source.commit,
      install: false,
      build: true,
      logRoot: join(source.cleanupRoot, "logs"),
    },
  );
});

test("normalizes volatile dates without removing meaningful HTML", () => {
  const normalized = normalizeHtml(
    '<main data-build="2026-08-21T10:00:00Z"><h1>Sol</h1></main>',
  );

  assert.equal(
    normalized,
    '<main data-build="__TIMESTAMP__"><h1>Sol</h1></main>',
  );
});

test("captures allowlisted headers and a normalized HTML artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "http-baseline-contract-"));
  cleanupRoots.push(root);
  const routeKey = "gone:/subvenciones|GET|anonymous|default";
  const contract = await captureHttpContract(
    routeKey,
    new Response(
      '<main data-build="2026-08-21T10:00:00Z"><h1>Sol</h1></main>',
      {
        status: 410,
        headers: {
          "Cache-Control": "public, max-age=3600",
          "Content-Type": "text/html; charset=utf-8",
          Date: "Thu, 21 Aug 2026 10:00:00 GMT",
          "X-Robots-Tag": "noindex",
        },
      },
    ),
    { root },
  );

  assert.equal(contract.status, 410);
  assert.deepEqual(contract.headers, {
    "cache-control": "public, max-age=3600",
    "content-type": "text/html; charset=utf-8",
    "x-robots-tag": "noindex",
  });
  assert.equal(
    contract.bodySha256,
    "ef17000c315fcbdbf75526639ec0664ffee8e8413b934f304c7e3555081cdd50",
  );
  assert.match(
    contract.normalizedHtmlPath ?? "",
    /^\.artifacts\/http-baseline\/gone_subvenciones.*\.html$/,
  );
  assert.equal(
    await readFile(join(root, contract.normalizedHtmlPath ?? ""), "utf8"),
    '<main data-build="__TIMESTAMP__"><h1>Sol</h1></main>',
  );
});

test("records gone text and API error shapes without storing private success bodies", async () => {
  const gone = await captureHttpContract(
    "gone:/subvenciones|GET|anonymous|default",
    new Response("Este servicio ya no forma parte de la oferta destacada.", {
      status: 410,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  );
  const apiError = await captureHttpContract(
    "api:/api/manganafer-quote|POST|anonymous|invalid-cups",
    Response.json(
      {
        ok: false,
        field: "cups",
        error: "Comprueba el CUPS.",
      },
      { status: 400 },
    ),
  );
  const privateSuccess = await captureHttpContract(
    "private-page:/guia-equipo-nueva-web-comunidad-solar.md|GET|allowed|default",
    new Response("Contenido privado", {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    }),
  );

  assert.equal(
    gone.bodyText,
    "Este servicio ya no forma parte de la oferta destacada.",
  );
  assert.deepEqual(apiError.bodyJsonShape, {
    error: "string",
    field: "string",
    ok: "boolean",
  });
  assert.equal(privateSuccess.bodyText, null);
  assert.equal(privateSuccess.bodyJsonShape, null);
});

test("plans identity and query variants with explicit phase deferrals", () => {
  const plan = buildCapturePlan(manifestFixture());
  const redirectVariants = plan.requests.filter(
    (request) => request.path === "/mision",
  );
  const partnerVariants = plan.requests.filter(
    (request) => request.path === "/socios",
  );
  const deferred = new Map(
    plan.deferred.map((entry) => [entry.routeKey, entry.deferredToPhase]),
  );

  assert.deepEqual(
    redirectVariants.map((request) => request.search),
    ["", "?utm_source=http-baseline"],
  );
  assert.deepEqual(
    partnerVariants.map((request) => request.identity),
    ["allowed", "anonymous", "denied", "unconfigured"],
  );
  assert.deepEqual(deferred, new Map([
    ["asset:/favicon.svg|GET|anonymous|asset-delivery", 2],
    [
      "api:/api/manganafer-interest|POST|anonymous|persistence",
      3,
    ],
    [
      "api:/api/manganafer-interest/export|GET|allowed|database-read",
      3,
    ],
    [
      "api:/api/manganafer-quote|POST|anonymous|external-quote",
      3,
    ],
    [
      "private-page:/manganafer/interesados|GET|allowed|database-read",
      3,
    ],
  ]));

  const baseline: HttpBaseline = {
    schemaVersion: 1,
    source: manifestFixture().source,
    contracts: plan.requests.map((request) => ({
      routeKey: request.routeKey,
      status: 200,
      headers: {},
      bodySha256: "0".repeat(64),
      normalizedHtmlPath: null,
      bodyText: null,
      bodyJsonShape: null,
    })),
    deferred: plan.deferred,
  };
  assert.doesNotThrow(() =>
    assertHttpBaselineCoverage(manifestFixture(), baseline),
  );
  baseline.contracts.pop();
  assert.throws(
    () => assertHttpBaselineCoverage(manifestFixture(), baseline),
    /Faltan contratos HTTP/i,
  );

  const reversed = {
    ...baseline,
    contracts: [...baseline.contracts].reverse(),
    deferred: [...baseline.deferred].reverse(),
  };
  assert.equal(
    serializeHttpBaseline(baseline),
    serializeHttpBaseline(reversed),
  );
});
