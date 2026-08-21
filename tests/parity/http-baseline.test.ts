import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import type { SourceManifest } from "../../scripts/lib/route-inventory.ts";
import {
  assertHttpBaselinesMatch,
  assertHttpBaselineCoverage,
  buildCapturePlan,
  captureHttpContract,
  htmlSemantics,
  normalizeHtml,
  resetHttpBaselineArtifacts,
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

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`No apareció el archivo esperado antes del deadline: ${path}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function processGroup(pid: number): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const group = Number(stdout.trim());
  if (!Number.isInteger(group) || group <= 0) {
    throw new Error(`ps no devolvió un PGID válido para ${pid}: ${stdout}`);
  }
  return group;
}

async function processDetails(pids: number[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-o", "pid=,ppid=,pgid=,command=", "-p", pids.join(",")],
    { encoding: "utf8" },
  );
  return stdout.trim();
}

interface PortableNpmFixture {
  callbackMarkerPath: string;
  fakeTimeoutMarkerPath: string;
  logRoot: string;
  npmMarkerPath: string;
  runnerPath: string;
  source: SourceFixture;
  binRoot: string;
}

async function createPortableNpmFixture(
  source: SourceFixture,
): Promise<PortableNpmFixture> {
  const binRoot = await mkdtemp(join(source.cleanupRoot, "portable-bin-"));
  const npmMarkerPath = join(source.cleanupRoot, "npm-ci-marker.json");
  const callbackMarkerPath = join(source.cleanupRoot, "callback-marker.txt");
  const fakeTimeoutMarkerPath = join(
    source.cleanupRoot,
    "unexpected-timeout-marker.txt",
  );
  const runnerPath = join(source.cleanupRoot, "run-portable-npm-install.ts");
  const [{ stdout: gitExecutable }, { stdout: tarExecutable }] =
    await Promise.all([
      execFileAsync("which", ["git"], { encoding: "utf8" }),
      execFileAsync("which", ["tar"], { encoding: "utf8" }),
    ]);
  await Promise.all([
    writeFile(
      join(binRoot, "git"),
      `#!/bin/sh\nexec ${JSON.stringify(gitExecutable.trim())} "$@"\n`,
      { mode: 0o755 },
    ),
    writeFile(
      join(binRoot, "tar"),
      `#!/bin/sh\nexec ${JSON.stringify(tarExecutable.trim())} "$@"\n`,
      { mode: 0o755 },
    ),
    writeFile(
      join(binRoot, "node"),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o755 },
    ),
    writeFile(
      join(binRoot, "npm"),
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.NPM_CI_MARKER, JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o755 },
    ),
    writeFile(
      join(binRoot, "timeout"),
      `#!/bin/sh\nprintf unexpected-timeout > "$FAKE_TIMEOUT_MARKER"\nexit 99\n`,
      { mode: 0o755 },
    ),
  ]);
  const sourceBuildUrl = new URL(
    "../../scripts/lib/temporary-source-build.ts",
    import.meta.url,
  ).href;
  await writeFile(
    runnerPath,
    `import { writeFile } from "node:fs/promises";
import { withTemporarySourceBuild } from ${JSON.stringify(sourceBuildUrl)};
async function main() {
  const [sourceRoot, commit, logRoot, callbackMarkerPath, deadline] = process.argv.slice(2);
  await withTemporarySourceBuild(
    async () => writeFile(callbackMarkerPath, "callback"),
    {
      sourceRoot,
      commit,
      install: true,
      build: false,
      ...(deadline === "" ? {} : { deadlineMs: Number(deadline) }),
      logRoot,
    },
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`,
  );
  return {
    binRoot,
    callbackMarkerPath,
    fakeTimeoutMarkerPath,
    logRoot: join(source.cleanupRoot, "logs"),
    npmMarkerPath,
    runnerPath,
    source,
  };
}

async function runPortableNpmInstall(
  fixture: PortableNpmFixture,
  deadlineMs: number | undefined,
): Promise<void> {
  await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      fixture.runnerPath,
      fixture.source.root,
      fixture.source.commit,
      fixture.logRoot,
      fixture.callbackMarkerPath,
      deadlineMs === undefined ? "" : String(deadlineMs),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: fixture.binRoot,
        NPM_CI_MARKER: fixture.npmMarkerPath,
        FAKE_TIMEOUT_MARKER: fixture.fakeTimeoutMarkerPath,
      },
    },
  );
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

function validBaselineFixture(manifest = manifestFixture()): HttpBaseline {
  const plan = buildCapturePlan(manifest);
  return {
    schemaVersion: 2,
    source: { ...manifest.source },
    contracts: plan.requests.map((request) => {
      const route = manifest.routes.find((entry) => entry.path === request.path);
      assert.ok(route, `No route fixture found for ${request.path}`);
      const common = {
        routeKey: request.routeKey,
        status:
          request.privateArea === null && request.method === "GET"
            ? route.expectedStatus
            : 200,
        headers: {},
      };
      if (request.privateArea !== null && request.identity === "allowed") {
        return {
          ...common,
          bodyCapture: "suppressed-private-success" as const,
        };
      }
      return {
        ...common,
        bodyCapture: "captured" as const,
        bodyComparison: "exact" as const,
        bodySha256: "a".repeat(64),
        normalizedHtmlPath: null,
        htmlSemantics: null,
        bodyText: null,
        bodyJsonShape: null,
      };
    }),
    deferred: plan.deferred.map((entry) => ({ ...entry })),
  };
}

async function temporaryBuildSessions(): Promise<string[]> {
  return (await readdir(tmpdir()))
    .filter((entry) => entry.startsWith("comunidadsolar-source-build-"))
    .sort();
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

test("returns GNU timeout status 124 when TERM is handled after the deadline", async () => {
  const source = await createSourceRepoFixture({
    "package.json": JSON.stringify({
      name: "temporary-timeout-status-fixture",
      private: true,
      scripts: {
        build:
          "timeout --signal=TERM 100ms node -e \"process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000)\"",
      },
    }),
  });
  const original = await snapshotRepository(source.root);

  await assert.rejects(
    withTemporarySourceBuild(
      async () => assert.fail("a timed-out build must not reach the callback"),
      {
        sourceRoot: source.root,
        commit: source.commit,
        install: false,
        build: true,
        logRoot: join(source.cleanupRoot, "logs"),
      },
    ),
    /código 124/i,
  );

  assert.deepEqual(await snapshotRepository(source.root), original);
});

test("terminates timeout descendants before they can outlive the temporary session", async () => {
  const markerRoot = await mkdtemp(join(tmpdir(), "http-baseline-descendant-"));
  cleanupRoots.push(markerRoot);
  const markerPath = join(markerRoot, "descendant-marker.txt");
  const pidPath = join(markerRoot, "descendant.pid");
  const source = await createSourceRepoFixture({
    "package.json": JSON.stringify({
      name: "temporary-timeout-descendant-fixture",
      private: true,
      scripts: {
        build: `timeout --signal=TERM --kill-after=200ms 500ms node parent.js ${JSON.stringify(markerPath)} ${JSON.stringify(pidPath)}`,
      },
    }),
    "parent.js": `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const child = spawn(process.execPath, [join(__dirname, "descendant.js"), process.argv[2]], { stdio: "ignore" });
writeFileSync(process.argv[3], String(child.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
    "descendant.js": `const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
setTimeout(() => writeFileSync(process.argv[2], "descendant survived"), 1_000);
setInterval(() => {}, 1_000);
`,
  });
  const original = await snapshotRepository(source.root);
  let descendantPid: number | undefined;

  try {
    await assert.rejects(
      withTemporarySourceBuild(
        async () => assert.fail("a timed-out build must not reach the callback"),
        {
          sourceRoot: source.root,
          commit: source.commit,
          install: false,
          build: true,
          logRoot: join(source.cleanupRoot, "logs"),
        },
      ),
      /código 124/i,
    );

    const capturedDescendantPid = Number(await readFile(pidPath, "utf8"));
    assert.ok(
      Number.isInteger(capturedDescendantPid) && capturedDescendantPid > 0,
    );
    descendantPid = capturedDescendantPid;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));
    assert.equal(existsSync(markerPath), false);
    assert.throws(() => process.kill(capturedDescendantPid, 0), {
      code: "ESRCH",
    });
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // The timeout process group has already terminated the descendant.
      }
    }
  }

  assert.deepEqual(await snapshotRepository(source.root), original);
});

test("enforces a total npm preparation deadline before returning from source cleanup", async () => {
  if (process.platform === "win32") return;
  const markerRoot = await mkdtemp(join(tmpdir(), "http-baseline-process-group-"));
  cleanupRoots.push(markerRoot);
  const markerPath = join(markerRoot, "descendant-marker.txt");
  const parentTermPath = join(markerRoot, "parent-term.txt");
  const pidPath = join(markerRoot, "pids.json");
  const source = await createSourceRepoFixture({
    "package.json": JSON.stringify({
      name: "temporary-process-group-fixture",
      private: true,
      scripts: {
        build: `node parent.js ${JSON.stringify(markerPath)} ${JSON.stringify(pidPath)} ${JSON.stringify(parentTermPath)}`,
      },
    }),
    "parent.js": `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const child = spawn(process.execPath, [join(__dirname, "descendant.js"), process.argv[2]], { stdio: "ignore" });
writeFileSync(process.argv[3], JSON.stringify({ parent: process.pid, descendant: child.pid }));
process.on("SIGTERM", () => {
  writeFileSync(process.argv[4], "received TERM");
  process.exit(0);
});
setInterval(() => {}, 1_000);
`,
    "descendant.js": `const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
setTimeout(() => writeFileSync(process.argv[2], "descendant survived " + Date.now()), 10_000);
setInterval(() => {}, 1_000);
`,
  });
  const original = await snapshotRepository(source.root);
  const sessionsBefore = await temporaryBuildSessions();
  let processPromise: Promise<void> | undefined;
  let processOutcome: Promise<unknown> | undefined;
  let pids: { parent: number; descendant: number } | undefined;
  try {
    const startedAt = Date.now();
    processPromise = withTemporarySourceBuild(
      async () => assert.fail("a timed-out build must not reach the callback"),
      {
        sourceRoot: source.root,
        commit: source.commit,
        install: false,
        build: true,
        logRoot: join(source.cleanupRoot, "logs"),
        deadlineMs: 5_000,
        processTimeoutMs: 6_000,
        processKillAfterMs: 30,
      },
    );
    processOutcome = processPromise.then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitForFile(pidPath, 5_000);
    pids = JSON.parse(await readFile(pidPath, "utf8")) as typeof pids;
    assert.ok(pids);
    const capturedPids = pids;
    const [parentGroup, descendantGroup] = await Promise.all([
      processGroup(capturedPids.parent),
      processGroup(capturedPids.descendant),
    ]);
    const details = await processDetails([
      capturedPids.parent,
      capturedPids.descendant,
      parentGroup,
    ]);
    assert.equal(
      parentGroup,
      descendantGroup,
      `el fixture debe mantener líder y descendiente en el mismo PGID:\n${details}`,
    );
    const observedOutcome = processOutcome;
    assert.ok(observedOutcome);
    const outcome = await Promise.race([
      observedOutcome,
      new Promise<Error>((resolvePromise) => {
        setTimeout(
          () =>
            resolvePromise(
              new Error("El build temporal no recibió deadline"),
            ),
          8_000,
        );
      }),
    ]);
    assert.ok(outcome instanceof Error);
    assert.match(
      outcome.message,
      /presupuesto total de preparación.*5000 ms/i,
    );
    assert.equal(existsSync(parentTermPath), true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
    const markerContents = existsSync(markerPath)
      ? await readFile(markerPath, "utf8")
      : "";
    let descendantAlive = false;
    try {
      process.kill(capturedPids.descendant, 0);
      descendantAlive = true;
    } catch {
      // The expected timeout cleanup has already removed the descendant.
    }
    assert.equal(
      existsSync(markerPath),
      false,
      `el descendiente escribió el marker antes de la comprobación: ${markerContents}; elapsed=${Number(markerContents.split(" ").at(-1)) - startedAt}; alive=${descendantAlive}`,
    );
    assert.throws(() => process.kill(capturedPids.descendant, 0), {
      code: "ESRCH",
    });
  } finally {
    if (pids === undefined && existsSync(pidPath)) {
      pids = JSON.parse(await readFile(pidPath, "utf8")) as typeof pids;
    }
    for (const pid of pids === undefined ? [] : [pids.parent, pids.descendant]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The bounded process group should already have removed fixture PIDs.
      }
    }
    if (processPromise !== undefined) {
      await Promise.race([
        processPromise.catch(() => undefined),
        new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_000)),
      ]);
    }
  }
  assert.deepEqual(await snapshotRepository(source.root), original);
  assert.deepEqual(await temporaryBuildSessions(), sessionsBefore);
});

test("uses the portable timeout for a deadline-only npm install without a build", async () => {
  if (process.platform === "win32") return;
  const source = await createSourceRepoFixture({
    "package.json": JSON.stringify({
      name: "portable-install-deadline-fixture",
      private: true,
    }),
  });
  const fixture = await createPortableNpmFixture(source);

  await runPortableNpmInstall(fixture, 10_000);

  assert.equal(await readFile(fixture.callbackMarkerPath, "utf8"), "callback");
  assert.equal(await readFile(fixture.npmMarkerPath, "utf8"), '["ci"]');
  assert.equal(existsSync(fixture.fakeTimeoutMarkerPath), false);
});

test("keeps a default install direct when no npm deadline is requested", async () => {
  if (process.platform === "win32") return;
  const source = await createSourceRepoFixture({
    "package.json": JSON.stringify({
      name: "portable-install-default-fixture",
      private: true,
    }),
  });
  const fixture = await createPortableNpmFixture(source);

  await runPortableNpmInstall(fixture, undefined);

  assert.equal(await readFile(fixture.callbackMarkerPath, "utf8"), "callback");
  assert.equal(await readFile(fixture.npmMarkerPath, "utf8"), '["ci"]');
  assert.equal(existsSync(fixture.fakeTimeoutMarkerPath), false);
});

test("provides the pinned HEAD, main branch, index, and reachable tags without creating .git", async () => {
  const source = await createSourceRepoFixture({
    "package.json": JSON.stringify({
      name: "temporary-git-fixture",
      private: true,
      scripts: {
        build:
          "git ls-files --cached > indexed.txt && git rev-parse HEAD > head.txt && git branch --show-current > branch.txt && git describe --tags HEAD > describe.txt",
      },
    }),
  });
  await git(source.root, ["tag", "-a", "v1.0.0", "-m", "fixture", source.commit]);
  const original = await snapshotRepository(source.root);
  const sourceDescription = await git(source.root, [
    "describe",
    "--tags",
    source.commit,
  ]);

  await withTemporarySourceBuild(
    async ({ root }) => {
      assert.equal(existsSync(join(root, ".git")), false);
      assert.equal(
        await readFile(join(root, "indexed.txt"), "utf8"),
        "package.json\ntracked.txt\n",
      );
      assert.equal(await readFile(join(root, "head.txt"), "utf8"), `${source.commit}\n`);
      assert.equal(await readFile(join(root, "branch.txt"), "utf8"), "main\n");
      assert.equal(await readFile(join(root, "describe.txt"), "utf8"), sourceDescription);
    },
    {
      sourceRoot: source.root,
      commit: source.commit,
      install: false,
      build: true,
      logRoot: join(source.cleanupRoot, "logs"),
    },
  );

  assert.deepEqual(await snapshotRepository(source.root), original);
});

test("uses one temporary session and cleans it after archive setup fails", async () => {
  const source = await createSourceRepoFixture();
  const original = await snapshotRepository(source.root);
  const before = await temporaryBuildSessions();
  let sessionsDuringBuild: string[] = [];

  await withTemporarySourceBuild(
    async () => {
      sessionsDuringBuild = await temporaryBuildSessions();
    },
    {
      sourceRoot: source.root,
      commit: source.commit,
      install: false,
      logRoot: join(source.cleanupRoot, "logs"),
    },
  );
  assert.equal(sessionsDuringBuild.length, before.length + 1);
  assert.deepEqual(await temporaryBuildSessions(), before);

  await assert.rejects(
    withTemporarySourceBuild(async () => undefined, {
      sourceRoot: source.root,
      commit: "does-not-exist",
      install: false,
      logRoot: join(source.cleanupRoot, "logs"),
    }),
    /git archive terminó/i,
  );
  assert.deepEqual(await temporaryBuildSessions(), before);
  assert.deepEqual(await snapshotRepository(source.root), original);
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

test("preserves meaningful HTML timestamps outside the data-build attribute", () => {
  const timestamp = "2026-08-21T10:00:00Z";
  const html = `<main data-build="${timestamp}"><time datetime="${timestamp}">Publicado ${timestamp}</time><section data-published="${timestamp}"></section><script>window.release = "${timestamp}"</script></main>`;

  assert.equal(
    normalizeHtml(html),
    `<main data-build="__TIMESTAMP__"><time datetime="${timestamp}">Publicado ${timestamp}</time><section data-published="${timestamp}"></section><script>window.release = "${timestamp}"</script></main>`,
  );
});

test("normalizes only a real mixed-quote data-build start-tag attribute", () => {
  const timestamp = "2026-08-21T10:00:00Z";
  const html = [
    `<main data-build='${timestamp}' data-label="release ${timestamp}">`,
    `<span x-data-build="${timestamp}" build-data-build="${timestamp}" data-build-version="${timestamp}">Visible ${timestamp}</span>`,
    `<!-- <main data-build="${timestamp}">Comment ${timestamp}</main> -->`,
    `<script>const plain = 'data-build="${timestamp}"'; const markup = "<main data-build='${timestamp}'>";</script>`,
    `<style>.card::before { content: "data-build='${timestamp}'"; }</style>`,
    `<textarea><main data-build="${timestamp}">${timestamp}</main></textarea>`,
    `<title><main data-build="${timestamp}">${timestamp}</main></title>`,
    "</main>",
  ].join("");

  assert.equal(
    normalizeHtml(html),
    [
      `<main data-build='__TIMESTAMP__' data-label="release ${timestamp}">`,
      `<span x-data-build="${timestamp}" build-data-build="${timestamp}" data-build-version="${timestamp}">Visible ${timestamp}</span>`,
      `<!-- <main data-build="${timestamp}">Comment ${timestamp}</main> -->`,
      `<script>const plain = 'data-build="${timestamp}"'; const markup = "<main data-build='${timestamp}'>";</script>`,
      `<style>.card::before { content: "data-build='${timestamp}'"; }</style>`,
      `<textarea><main data-build="${timestamp}">${timestamp}</main></textarea>`,
      `<title><main data-build="${timestamp}">${timestamp}</main></title>`,
      "</main>",
    ].join(""),
  );
});

test("normalizes only an entire exact data-build timestamp value", () => {
  const timestamp = "2026-08-21T10:00:00Z";
  const html = [
    `<main data-build="${timestamp}"></main>`,
    `<main DATA-BUILD='${timestamp}'></main>`,
    `<main data-build="release-${timestamp}"></main>`,
    `<main data-build="${timestamp}-v2"></main>`,
    `<main data-build=" ${timestamp} "></main>`,
    `<main data-build="release ${timestamp} candidate"></main>`,
    `<main data-build="${timestamp},${timestamp}"></main>`,
  ].join("");

  assert.equal(
    normalizeHtml(html),
    [
      '<main data-build="__TIMESTAMP__"></main>',
      "<main DATA-BUILD='__TIMESTAMP__'></main>",
      `<main data-build="release-${timestamp}"></main>`,
      `<main data-build="${timestamp}-v2"></main>`,
      `<main data-build=" ${timestamp} "></main>`,
      `<main data-build="release ${timestamp} candidate"></main>`,
      `<main data-build="${timestamp},${timestamp}"></main>`,
    ].join(""),
  );
});

test("normalizes volatile source-build asset and RSC identifiers", () => {
  const first = String.raw`<link href="/assets/index-B7W9r4T8.css"/><script>import("/assets/index-B0GTT5J1.js")</script><script>self.__VINEXT_RSC_CHUNKS__.push("2:I[\"8c0f216c4604\",[],\"Children\",1]\n0:{\"deploymentVersion\":\"e72eaee0-a3b6-4821-9a2c-36e1e5d7ef52\"}")</script><img src="/comunidad-solar-logo.svg"/><p>Oferta R2-883</p>`;
  const second = String.raw`<link href="/assets/index-C1D2E3F4.css"/><script>import("/assets/index-Z9Y8X7W6.js")</script><script>self.__VINEXT_RSC_CHUNKS__.push("2:I[\"b85b39017127\",[],\"Children\",1]\n0:{\"deploymentVersion\":\"8c511eec-9748-45d4-8fcb-8d988821ecf8\"}")</script><img src="/comunidad-solar-logo.svg"/><p>Oferta R2-883</p>`;

  const normalized = normalizeHtml(first);

  assert.equal(normalized, normalizeHtml(second));
  assert.match(normalized, /\/assets\/index-__ASSET_HASH__\.css/);
  assert.match(normalized, /__RSC_MODULE_ID__/);
  assert.match(normalized, /__DEPLOYMENT_VERSION__/);
  assert.match(normalized, /comunidad-solar-logo\.svg/);
  assert.match(normalized, /Oferta R2-883/);
});

test("hashes sitemap XML after normalizing volatile last-modified timestamps", async () => {
  const first = await captureHttpContract(
    "page:/sitemap.xml|GET|anonymous|default",
    new Response(
      "<urlset><url><loc>https://comunidadsolar.es/</loc><lastmod>2026-08-21T14:10:15.425Z</lastmod></url></urlset>",
      { headers: { "content-type": "application/xml; charset=utf-8" } },
    ),
  );
  const second = await captureHttpContract(
    "page:/sitemap.xml|GET|anonymous|default",
    new Response(
      "<urlset><url><loc>https://comunidadsolar.es/</loc><lastmod>2026-08-21T14:12:30.001Z</lastmod></url></urlset>",
      { headers: { "content-type": "application/xml; charset=utf-8" } },
    ),
  );

  if (first.bodyCapture !== "captured") assert.fail("expected captured XML contract");
  if (second.bodyCapture !== "captured") assert.fail("expected captured XML contract");
  assert.equal(first.bodySha256, second.bodySha256);
});

test("preserves sitemap XML timestamps outside lastmod", async () => {
  const routeKey = "page:/sitemap.xml|GET|anonymous|default";
  const first = await captureHttpContract(
    routeKey,
    new Response(
      "<urlset><url><lastmod>2026-08-21T14:10:15.425Z</lastmod><updated>2026-08-21T14:10:15.425Z</updated></url></urlset>",
      { headers: { "content-type": "application/xml; charset=utf-8" } },
    ),
  );
  const second = await captureHttpContract(
    routeKey,
    new Response(
      "<urlset><url><lastmod>2026-08-21T14:10:15.425Z</lastmod><updated>2026-08-21T14:12:30.001Z</updated></url></urlset>",
      { headers: { "content-type": "application/xml; charset=utf-8" } },
    ),
  );

  if (first.bodyCapture !== "captured") assert.fail("expected captured XML contract");
  if (second.bodyCapture !== "captured") assert.fail("expected captured XML contract");
  assert.notEqual(first.bodySha256, second.bodySha256);
});

test("preserves lastmod timestamps outside the sitemap route", async () => {
  const routeKey = "page:/feed.xml|GET|anonymous|default";
  const first = await captureHttpContract(
    routeKey,
    new Response(
      "<feed><lastmod>2026-08-21T14:10:15.425Z</lastmod></feed>",
      { headers: { "content-type": "application/xml; charset=utf-8" } },
    ),
  );
  const second = await captureHttpContract(
    routeKey,
    new Response(
      "<feed><lastmod>2026-08-21T14:12:30.001Z</lastmod></feed>",
      { headers: { "content-type": "application/xml; charset=utf-8" } },
    ),
  );

  if (first.bodyCapture !== "captured") assert.fail("expected captured XML contract");
  if (second.bodyCapture !== "captured") assert.fail("expected captured XML contract");
  assert.notEqual(first.bodySha256, second.bodySha256);
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

  if (contract.bodyCapture !== "captured") assert.fail("expected captured HTML contract");

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

test("captures ordered public HTML semantics before persisting its artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "http-baseline-semantics-"));
  cleanupRoots.push(root);
  const contract = await captureHttpContract(
    "page:/|GET|anonymous|default",
    new Response(
      [
        "<!-- hidden comment -->",
        '<LINK href="https://comunidadsolar.es/?a=1&amp;b=2" data-x="1" REL=\'canonical\'>',
        '<link REL="stylesheet canonical" href=\'/nosotros?x=1&amp;y=2\'>',
        '<META CONTENT="noindex, nofollow" NAME=robots>',
        '<meta name="ROBOTS" content=\'noarchive &amp; nosnippet\'>',
        "<main> Comunidad <strong>Solar&nbsp;S. Coop.</strong><script>oculto</script><style>.hidden {}</style><p>&amp; energía</p></main>",
      ].join(""),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    ),
    { root },
  );

  if (contract.bodyCapture !== "captured") assert.fail("expected captured HTML contract");
  const semanticContract = contract as typeof contract & {
    bodyComparison?: unknown;
    htmlSemantics?: unknown;
  };

  assert.equal(semanticContract.bodyComparison, "exact");
  assert.deepEqual(semanticContract.htmlSemantics, {
    canonical: [
      "https://comunidadsolar.es/?a=1&b=2",
      "/nosotros?x=1&y=2",
    ],
    robots: ["noindex, nofollow", "noarchive & nosnippet"],
    normalizedText: "Comunidad Solar S. Coop. & energía",
  });
  assert.match(
    contract.normalizedHtmlPath ?? "",
    /^\.artifacts\/http-baseline\//,
  );
});

test("preserves later public text after U+0130 before raw script and style tags", () => {
  const expandingPrefix = "İ".repeat(10);

  for (const rawTag of ["script", "style"] as const) {
    assert.deepEqual(
      htmlSemantics(
        `${expandingPrefix}<${rawTag}>hidden ${rawTag}</${rawTag}><p>later ${rawTag} text</p><p>${rawTag} tail</p>`,
      ),
      {
        canonical: [],
        robots: [],
        normalizedText: `${expandingPrefix} later ${rawTag} text ${rawTag} tail`,
      },
    );
  }
});

test("normalizes later data-build attributes after U+0130 before raw tags", () => {
  const expandingPrefix = "İ".repeat(10);
  const timestamp = "2026-08-21T00:00:00Z";

  for (const rawTag of ["script", "style"] as const) {
    const html = `${expandingPrefix}<${rawTag}>hidden ${rawTag}</${rawTag}><p data-build="${timestamp}">later ${rawTag} text</p><p data-build="${timestamp}">${rawTag} tail</p>`;

    assert.equal(
      normalizeHtml(html),
      `${expandingPrefix}<${rawTag}>hidden ${rawTag}</${rawTag}><p data-build="__TIMESTAMP__">later ${rawTag} text</p><p data-build="__TIMESTAMP__">${rawTag} tail</p>`,
    );
  }
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

  if (gone.bodyCapture !== "captured") assert.fail("expected captured gone contract");
  if (apiError.bodyCapture !== "captured") assert.fail("expected captured API contract");

  assert.equal(
    gone.bodyText,
    "Este servicio ya no forma parte de la oferta destacada.",
  );
  assert.deepEqual(apiError.bodyJsonShape, {
    error: "string",
    field: "string",
    ok: "boolean",
  });
  assert.equal(privateSuccess.bodyCapture, "suppressed-private-success");
  assert.equal(Object.hasOwn(privateSuccess, "bodySha256"), false);
  assert.equal(Object.hasOwn(privateSuccess, "normalizedHtmlPath"), false);
  assert.equal(Object.hasOwn(privateSuccess, "bodyText"), false);
  assert.equal(Object.hasOwn(privateSuccess, "bodyJsonShape"), false);
  assert.equal(Object.hasOwn(privateSuccess, "bodyComparison"), false);
  assert.equal(Object.hasOwn(privateSuccess, "htmlSemantics"), false);
});

test("suppresses every body field and artifact for an allowed private success", async () => {
  const root = await mkdtemp(join(tmpdir(), "http-baseline-private-contract-"));
  cleanupRoots.push(root);
  const routeKey = "private-page:/socios|GET|allowed|default";
  const response = new Response(
    "<main>Contenido privado que no debe persistirse</main>",
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
  Object.defineProperty(response, "text", {
    value: async () => {
      throw new Error("a suppressed private response must not be read");
    },
  });

  const contract = await captureHttpContract(
    routeKey,
    response,
    { root, suppressBody: true },
  );

  assert.deepEqual(contract, {
    routeKey,
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
    bodyCapture: "suppressed-private-success",
  });
  assert.equal(existsSync(join(root, ".artifacts", "http-baseline")), false);
});

test("writes candidate HTML artifacts outside the immutable baseline namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "http-baseline-candidate-artifacts-"));
  cleanupRoots.push(root);
  const routeKey = "page:/|GET|anonymous|default";
  const baseline = await captureHttpContract(
    routeKey,
    new Response("<main>Baseline public text</main>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
    { root },
  );
  const candidate = await captureHttpContract(
    routeKey,
    new Response("<main>Candidate public text</main>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
    { root, artifactNamespace: "candidate" },
  );

  if (baseline.bodyCapture !== "captured") assert.fail("expected baseline HTML capture");
  if (candidate.bodyCapture !== "captured") assert.fail("expected candidate HTML capture");
  assert.match(baseline.normalizedHtmlPath ?? "", /^\.artifacts\/http-baseline\//);
  assert.match(candidate.normalizedHtmlPath ?? "", /^\.artifacts\/http-candidate\//);
  assert.equal(
    await readFile(join(root, baseline.normalizedHtmlPath ?? ""), "utf8"),
    "<main>Baseline public text</main>",
  );
  assert.equal(
    await readFile(join(root, candidate.normalizedHtmlPath ?? ""), "utf8"),
    "<main>Candidate public text</main>",
  );
});

test("clears residual private artifacts before regenerating public artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "http-baseline-regeneration-"));
  cleanupRoots.push(root);
  const artifactRoot = join(root, ".artifacts", "http-baseline");
  const oldPrivateArtifact = join(artifactRoot, "private-success.html");
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(oldPrivateArtifact, "Contenido privado histórico");

  await resetHttpBaselineArtifacts(root);
  const publicContract = await captureHttpContract(
    "page:/|GET|anonymous|default",
    new Response("<main>Contenido público</main>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
    { root },
  );

  assert.equal(existsSync(oldPrivateArtifact), false);
  assert.equal(
    existsSync(join(root, publicContract.bodyCapture === "captured" ? publicContract.normalizedHtmlPath ?? "" : "")),
    true,
  );
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

  const baseline = validBaselineFixture(manifestFixture());
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

test("rejects malformed captured values, source, and deferral details during coverage", () => {
  const manifest = manifestFixture();
  const baseline = validBaselineFixture(manifest);
  const capturedIndex = baseline.contracts.findIndex(
    (contract) => contract.bodyCapture === "captured",
  );
  assert.notEqual(capturedIndex, -1);
  const deferredIndex = 0;

  const invalidStatus = structuredClone(baseline);
  invalidStatus.contracts[capturedIndex].status = 599;
  assert.throws(
    () => assertHttpBaselineCoverage(manifest, invalidStatus),
    /estado HTTP/i,
  );

  const invalidHash = structuredClone(baseline);
  const hashContract = invalidHash.contracts[capturedIndex];
  if (hashContract.bodyCapture !== "captured") assert.fail("expected captured contract");
  hashContract.bodySha256 = "0".repeat(64);
  assert.throws(
    () => assertHttpBaselineCoverage(manifest, invalidHash),
    /hash/i,
  );

  const missingBodyComparison = structuredClone(baseline);
  const missingModeContract = missingBodyComparison.contracts[capturedIndex];
  if (missingModeContract.bodyCapture !== "captured") {
    assert.fail("expected captured contract");
  }
  delete (missingModeContract as { bodyComparison?: unknown }).bodyComparison;
  assert.throws(
    () => assertHttpBaselineCoverage(manifest, missingBodyComparison),
    /modo de comparación/i,
  );

  const missingHtmlSemantics = structuredClone(baseline);
  const missingSemanticsContract = missingHtmlSemantics.contracts[capturedIndex];
  if (missingSemanticsContract.bodyCapture !== "captured") {
    assert.fail("expected captured contract");
  }
  missingSemanticsContract.headers = {
    "content-type": "text/html; charset=utf-8",
  };
  missingSemanticsContract.htmlSemantics = null;
  assert.throws(
    () => assertHttpBaselineCoverage(manifest, missingHtmlSemantics),
    /semántica HTML/i,
  );

  const invalidHeader = structuredClone(baseline);
  invalidHeader.contracts[capturedIndex].headers = { "x-unallowlisted": "leak" };
  assert.throws(
    () => assertHttpBaselineCoverage(manifest, invalidHeader),
    /cabecera/i,
  );

  const invalidSource = structuredClone(baseline);
  (invalidSource.source as { commit: string }).commit = "0".repeat(40);
  assert.throws(
    () => assertHttpBaselineCoverage(manifest, invalidSource),
    /referencia fuente/i,
  );

  const invalidDeferred = structuredClone(baseline);
  invalidDeferred.deferred[deferredIndex].reason = "changed";
  assert.throws(
    () => assertHttpBaselineCoverage(manifest, invalidDeferred),
    /deferrals HTTP/i,
  );
});

test("compares every canonical HTTP contract value against a fresh capture", () => {
  const baseline = validBaselineFixture();
  const capturedIndex = baseline.contracts.findIndex(
    (contract) => contract.bodyCapture === "captured",
  );
  assert.notEqual(capturedIndex, -1);

  assert.doesNotThrow(() => assertHttpBaselinesMatch(baseline, baseline));

  const changes: Array<[string, HttpBaseline]> = [];
  const changedStatus = structuredClone(baseline);
  changedStatus.contracts[capturedIndex].status = 599;
  changes.push(["status", changedStatus]);

  const changedHash = structuredClone(baseline);
  const hashContract = changedHash.contracts[capturedIndex];
  if (hashContract.bodyCapture !== "captured") assert.fail("expected captured contract");
  hashContract.bodySha256 = "b".repeat(64);
  changes.push(["hash", changedHash]);

  const changedHeader = structuredClone(baseline);
  changedHeader.contracts[capturedIndex].headers = {
    "cache-control": "changed",
  };
  changes.push(["header", changedHeader]);

  const changedSource = structuredClone(baseline);
  (changedSource.source as { commit: string }).commit = "b".repeat(40);
  changes.push(["source", changedSource]);

  const changedDeferred = structuredClone(baseline);
  changedDeferred.deferred[0].reason = "changed";
  changes.push(["deferral", changedDeferred]);

  for (const [field, changed] of changes) {
    assert.throws(
      () => assertHttpBaselinesMatch(baseline, changed),
      /captura HTTP fresca difiere/i,
      `Expected ${field} to fail the canonical comparison`,
    );
  }
});
