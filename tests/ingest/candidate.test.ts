import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { sha256Canonical } from "../../src/ingest/canonical-json.ts";
import {
  createCandidate,
  createCandidatePromotionTestCapability,
  loadCandidate,
  openControllerCandidateStore,
  releaseControllerCandidateStore,
  verifyCandidateArtifact,
  type CandidateCreationInput,
  type CandidatePromotionFailureStage,
  type ControllerCandidateStore,
} from "../../src/ingest/candidate/manifest.ts";
import {
  createCandidateBuildTestCapability,
  type CandidateBuildFixture,
  type CandidateBuildTestCapability,
} from "../../src/ingest/candidate/evidence.ts";
import {
  createCandidatePreviewTestCapability,
  startCandidatePreview,
  type CandidatePreviewTestCapability,
  type PreviewAssertionDescriptor,
} from "../../src/ingest/candidate/preview.ts";
import { hashTree } from "../../src/ingest/candidate/tree-digest.ts";
import type { ChangePlan, ValidationResult } from "../../src/ingest/domain.ts";
import {
  preparePlanningPublication,
  type PreparedPlanningPublication,
} from "../../src/ingest/planning/plan.ts";
import {
  createControllerPublicationProfile,
  createValidationEvidenceRoot,
  runValidation,
  type CommandInvocation,
  type CommandResult,
  type ControllerPublicationProfile,
  type ValidationEvidenceRoot,
} from "../../src/ingest/validation/runner.ts";
import {
  removeStagedAgentOutput,
  validateAgentWorkspaceOutput,
  type StagedAgentOutput,
} from "../../src/ingest/workspaces/policy.ts";
import {
  createAgentWorkspace,
  removeAgentWorkspace,
} from "../../src/ingest/workspaces/service.ts";

process.env.INGEST_TEST_MODE ??= "true";

const execFileAsync = promisify((await import("node:child_process")).execFile);
const changeId = "candidate-output";
const attemptId = "attempt-000001";
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

type OutputFiles = Readonly<Record<string, string | Uint8Array>>;

function routePath(plan: ChangePlan): string {
  return plan.targetPath === "/"
    ? "src/pages/index.astro"
    : `src/pages${plan.targetPath}.astro`;
}

function request() {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId,
    inputKind: "request" as const,
    intent: "Create immutable candidate",
    audience: null,
    targetPath: "/candidate" as const,
    mode: "blocks" as const,
    content: "Candidate fixture content",
    claims: [],
    references: [],
    assets: [],
    seo: { title: "Candidate", description: "Fixture", index: false },
    privacy: { private: false, area: null },
    allowedExternalLinks: [],
    acceptanceCriteria: ["Candidate stays immutable"],
  };
  return { ...unsigned, inputSha256: sha256Canonical(unsigned) };
}

function fixturePlan(
  baselineCommit: string,
  publication: PreparedPlanningPublication,
): ChangePlan {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId,
    baselineCommit,
    requestSha256: request().inputSha256,
    selectedMode: "blocks" as const,
    targetPath: "/candidate" as const,
    overwritesExistingRoute: false,
    files: [
      { path: "src/pages/candidate.astro", operation: "create" as const },
      {
        path: `src/components/generated/${changeId}`,
        operation: "create" as const,
      },
      {
        path: `src/content/generated/${changeId}.json`,
        operation: "create" as const,
      },
      {
        path: `src/styles/generated/${changeId}.css`,
        operation: "create" as const,
      },
      {
        path: `public/generated/${changeId}`,
        operation: "create" as const,
      },
    ],
    components: ["SiteLayout"],
    islands: [],
    dependencies: [],
    validations: ["output-policy", "build"],
    publication: {
      adapter: publication.adapter,
      configSha256: publication.configSha256,
      environment: publication.environment,
      siteIndexable: publication.siteIndexable,
    },
  };
  return { ...unsigned, planSha256: sha256Canonical(unsigned) };
}

function blockRoute(plan: ChangePlan): string {
  return `---
import GeneratedBlockPage from "../components/blocks/GeneratedBlockPage.astro";
import page from "../content/generated/${plan.changeId}.json";
---
<GeneratedBlockPage {page} />
`;
}

function validOutput(plan: ChangePlan): OutputFiles {
  const route = blockRoute(plan);
  return {
    [routePath(plan)]: route,
    [`src/content/generated/${plan.changeId}.json`]: JSON.stringify({
      schemaVersion: 1,
      changeId: plan.changeId,
      mode: plan.selectedMode,
      route: plan.targetPath,
      metadata: {
        title: "Candidate fixture",
        description: "A closed candidate fixture.",
        index: false,
      },
      privacy: { private: false, area: null },
      contentSha256: sha256(route),
      blocks: [
        {
          type: "hero",
          eyebrow: "Energía compartida",
          title: "Candidato inmutable",
          lead: "Una salida comprobable.",
          primary: { label: "Contacto", href: "/contacto" },
        },
      ],
    }),
  };
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function writeFiles(root: string, files: OutputFiles): Promise<void> {
  for (const [path, source] of Object.entries(files)) {
    const destination = join(root, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, source);
  }
}

async function installFixtureWrangler(repositoryRoot: string): Promise<string> {
  const executable = join(repositoryRoot, "node_modules", ".bin", "wrangler");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o700);
  return executable;
}

function passingResult(command: CommandInvocation): CommandResult {
  return {
    exitCode: 0,
    stdout: "fixture command passed",
    stderr: "",
    timedOut: false,
    aborted: false,
    unsupported: false,
    ...(command.browser === undefined
      ? {}
      : {
          browserProof: {
            ...command.browser,
            evidenceSha256: "e".repeat(64),
          },
        }),
  };
}

interface BuildFixtureOptions {
  readonly redirect?: string;
  readonly targetEnvironment?: string | null;
  readonly siteIndexable?: boolean;
  readonly bindings?: readonly string[];
}

function candidateBuildFixture(
  plan: ChangePlan,
  options: BuildFixtureOptions = {},
  additionalFiles: OutputFiles = {},
): CandidateBuildFixture {
  const targetEnvironment =
    options.targetEnvironment ?? plan.publication.environment;
  const siteIndexable = options.siteIndexable ?? plan.publication.siteIndexable;
  const bindings = options.bindings ?? ["ASSETS", "DB"];
  const destination = {
    binding: "DB",
    database_id: "00000000-0000-4000-8000-000000000000",
    database_name: "candidate-fixture",
    migrations_dir: "drizzle",
  };
  const config = JSON.stringify({
    targetEnvironment,
    name: "candidate-fixture",
    main: "_worker.js/index.js",
    assets: { binding: "ASSETS", directory: ".", run_worker_first: true },
    vars: { SITE_INDEXABLE: siteIndexable ? "true" : "false" },
    bindings,
    d1_databases: [destination],
  });
  const nestedConfig = JSON.stringify({
    targetEnvironment,
    name: "candidate-fixture",
    main: "../_worker.js/index.js",
    assets: { binding: "ASSETS", directory: "..", run_worker_first: true },
    vars: { SITE_INDEXABLE: siteIndexable ? "true" : "false" },
    bindings,
    d1_databases: [destination],
  });
  return {
    files: {
      "dist/_worker.js/index.js":
        "export default { fetch() { return new Response('ok'); } };\n",
      "dist/index.html": "<main>immutable candidate</main>\n",
      "dist/wrangler.json": config,
      "dist/.prerender/wrangler.json": nestedConfig,
      "dist/auxiliary/wrangler.json": nestedConfig,
      ".wrangler/deploy/config.json":
        options.redirect ??
        JSON.stringify({
          configPath: "../../dist/wrangler.json",
          auxiliaryWorkers: ["../../dist/auxiliary/wrangler.json"],
          prerenderWorkerConfigPath: "../../dist/.prerender/wrangler.json",
        }),
      ...additionalFiles,
    },
    validations: [
      { id: "candidate-build", status: "passed", evidence: "fixture" },
    ],
  };
}

interface CandidateFixture {
  readonly repositoryRoot: string;
  readonly output: StagedAgentOutput;
  readonly plan: ChangePlan;
  readonly validations: ValidationResult[];
  readonly store: ControllerCandidateStore;
  readonly build: CandidateBuildTestCapability;
}

/** Test-only fixture setup; production candidate APIs receive no raw root. */
async function openFixtureCandidateStore(
  repositoryRoot: string,
): Promise<ControllerCandidateStore> {
  const previous = process.cwd();
  process.chdir(repositoryRoot);
  try {
    return await openControllerCandidateStore();
  } finally {
    process.chdir(previous);
  }
}

function fixtureCandidateBundlePath(repositoryRoot: string): string {
  return join(
    repositoryRoot,
    ".artifacts",
    "candidates",
    changeId,
    attemptId,
    "bundle",
  );
}

type PublicPreviewDescriptor = Parameters<
  Parameters<typeof createCandidatePreviewTestCapability>[0]
>[0];
type PublicPromotionStage = Parameters<
  typeof createCandidatePromotionTestCapability
>[0];

function compilePublicPreviewSurface(
  descriptor: PublicPreviewDescriptor,
  promotionStage: PublicPromotionStage,
  preview: typeof import("../../src/ingest/candidate/preview.ts"),
  manifest: typeof import("../../src/ingest/candidate/manifest.ts"),
): void {
  const safe: PreviewAssertionDescriptor = descriptor;
  void safe;
  // @ts-expect-error Raw execution details must not be public preview data.
  void descriptor.cwd;
  // @ts-expect-error Raw execution details must not be public preview data.
  void descriptor.argv;
  // @ts-expect-error Raw execution details must not be public preview data.
  void descriptor.env;
  // @ts-expect-error Raw execution details must not be public preview data.
  void descriptor.executable;
  // @ts-expect-error Raw bundle authority must not be public preview data.
  void descriptor.bundlePath;
  // @ts-expect-error Test-only raw initializer must not remain public.
  void manifest.createControllerCandidateStoreTestInitialization;
  // @ts-expect-error Test-only raw inspection must not remain public.
  void manifest.candidateTestInspection;
  // @ts-expect-error Fixed process invocation must not be re-exported.
  void preview.FixedPreviewInvocation;
  const safePromotionStage: CandidatePromotionFailureStage = promotionStage;
  void safePromotionStage;
  // @ts-expect-error The promotion token accepts a stage, never a callback.
  createCandidatePromotionTestCapability(async () => undefined);
}

void compilePublicPreviewSurface;

async function withCandidateFixture(
  buildOptions: BuildFixtureOptions,
  run: (fixture: CandidateFixture) => Promise<void>,
  commandResult: (
    command: CommandInvocation,
  ) => CommandResult | Promise<CommandResult> = passingResult,
): Promise<void> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "candidate-repository-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "candidate-workspace-"));
  const authorityRoot = await mkdtemp(join(tmpdir(), "candidate-input-"));
  let workspace: Awaited<ReturnType<typeof createAgentWorkspace>> | undefined;
  let output: StagedAgentOutput | undefined;
  let evidenceRoot: ValidationEvidenceRoot | undefined;
  let store: ControllerCandidateStore | undefined;
  try {
    await execFileAsync("git", [
      "init",
      "--quiet",
      "--object-format=sha256",
      "--initial-branch=main",
      repositoryRoot,
    ]);
    await git(repositoryRoot, ["config", "user.email", "fixture@example.test"]);
    await git(repositoryRoot, ["config", "user.name", "Fixture Human"]);
    await writeFiles(repositoryRoot, {
      "README.md": "candidate fixture\n",
      ".gitignore": ".artifacts/\n.change-state/\n.wrangler/\ndist/\n",
      "package.json":
        '{"name":"candidate-fixture","version":"1.0.0","private":true}\n',
      "package-lock.json":
        '{"name":"candidate-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"candidate-fixture","version":"1.0.0"}}}\n',
      "src/pages/index.astro": "<main>Inicio</main>\n",
      "src/pages/contacto.astro": "<main>Contacto</main>\n",
      "src/components/blocks/GeneratedBlockPage.astro": "<main>Blocks</main>\n",
      "src/worker.ts": "export default {};\n",
      "drizzle/0000_fixture.sql": "SELECT 1;\n",
      "wrangler.jsonc": JSON.stringify({
        name: "candidate-fixture",
        main: "./src/worker.ts",
        compatibility_date: "2026-08-21",
        compatibility_flags: ["nodejs_compat"],
        assets: {
          binding: "ASSETS",
          directory: "./dist",
          run_worker_first: true,
        },
        d1_databases: [
          {
            binding: "DB",
            database_name: "candidate-fixture",
            database_id: "00000000-0000-4000-8000-000000000000",
            migrations_dir: "./drizzle",
          },
        ],
        vars: { SITE_INDEXABLE: "false" },
      }),
    });
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "--quiet", "-m", "fixture baseline"]);
    const baselineCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const publication = await preparePlanningPublication({
      adapter: "local",
      projectRoot: repositoryRoot,
      stateArtifactRoot: join(repositoryRoot, ".change-state", "profile"),
    });
    const plan = fixturePlan(baselineCommit, publication);
    const requestPath = join(authorityRoot, "request.json");
    const planPath = join(authorityRoot, "plan.json");
    const policyPath = join(authorityRoot, "policy.json");
    const resultSchemaPath = join(authorityRoot, "agent-result.schema.json");
    await Promise.all([
      writeFile(requestPath, JSON.stringify(request())),
      writeFile(planPath, JSON.stringify(plan)),
      writeFile(policyPath, '{"allow":"planned-only"}'),
      writeFile(resultSchemaPath, '{"type":"object"}'),
    ]);
    workspace = await createAgentWorkspace({
      repositoryRoot,
      workspaceRoot,
      approvedPlan: plan,
      changeId,
      attemptId,
      baselineCommit,
      requestPath,
      planPath,
      policyPath,
      resultSchemaPath,
    });
    await writeFiles(workspace.path, validOutput(plan));
    output = await validateAgentWorkspaceOutput(workspace, plan);
    evidenceRoot = await createValidationEvidenceRoot(output, plan, attemptId);
    const publicationProfile: ControllerPublicationProfile =
      await createControllerPublicationProfile(
        output,
        plan,
        attemptId,
        publication,
      );
    const validations = await runValidation(
      {
        output,
        plan,
        attemptId,
        evidenceRoot,
        publicationProfile,
      },
      { commands: async (command) => await commandResult(command) },
    );
    store = await openFixtureCandidateStore(repositoryRoot);
    const build = createCandidateBuildTestCapability(
      candidateBuildFixture(plan, buildOptions),
    );
    await run({
      repositoryRoot,
      output,
      plan,
      validations,
      store,
      build,
    });
  } finally {
    if (store !== undefined) {
      await releaseControllerCandidateStore(store).catch(() => undefined);
    }
    if (output !== undefined) {
      await removeStagedAgentOutput(output).catch(() => undefined);
    }
    if (workspace !== undefined) {
      await removeAgentWorkspace(workspace).catch(() => undefined);
    }
    await Promise.all([
      rm(repositoryRoot, { recursive: true, force: true }),
      rm(workspaceRoot, { recursive: true, force: true }),
      rm(authorityRoot, { recursive: true, force: true }),
      ...(evidenceRoot === undefined
        ? []
        : [rm(evidenceRoot.path, { recursive: true, force: true })]),
    ]);
  }
}

function candidateInput(
  fixture: CandidateFixture,
  preview?: CandidatePreviewTestCapability,
): CandidateCreationInput {
  return {
    output: fixture.output,
    plan: fixture.plan,
    attemptId,
    preliminaryValidations: fixture.validations,
    store: fixture.store,
    buildCapability: fixture.build,
    ...(preview === undefined ? {} : { previewCapability: preview }),
  };
}

type ProcessGroupSignal = NodeJS.Signals | number | undefined;

interface StartedDetachedPreview {
  readonly handle: Awaited<ReturnType<typeof startCandidatePreview>>;
  readonly pid: number;
  readonly closed: Promise<void>;
}

function processGroupError(code: "EPERM" | "ESRCH"): NodeJS.ErrnoException {
  const error = new Error(`kill ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function startDetachedPreview(
  fixture: CandidateFixture,
  onExit: () => void = () => undefined,
): Promise<StartedDetachedPreview> {
  await installFixtureWrangler(fixture.repositoryRoot);
  let child: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  const preview = createCandidatePreviewTestCapability(async () => {
    const launched = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1_000);"],
      { detached: true, stdio: "ignore" },
    );
    child = launched;
    launched.once("exit", onExit);
    closed = new Promise<void>((resolveClosed) => {
      launched.once("close", () => resolveClosed());
    });
    return { child: launched, url: "http://127.0.0.1:43124" };
  });
  const candidate = await createCandidate(candidateInput(fixture, preview));
  const handle = await startCandidatePreview(candidate);
  const launched = child;
  const close = closed;
  if (
    launched === undefined ||
    typeof launched.pid !== "number" ||
    close === undefined
  ) {
    throw new Error("El fixture de preview no inició un proceso");
  }
  return Object.freeze({ handle, pid: launched.pid, closed: close });
}

function interceptPreviewProcessGroup(
  t: TestContext,
  pid: number,
  intercept: (signal: ProcessGroupSignal) => boolean,
): typeof process.kill {
  const originalKill = process.kill.bind(process);
  t.mock.method(
    process,
    "kill",
    (target: number, signal?: ProcessGroupSignal): boolean => {
      if (target === -pid) return intercept(signal);
      return originalKill(target, signal);
    },
  );
  return originalKill;
}

async function reapDetachedPreview(
  preview: StartedDetachedPreview,
  kill: typeof process.kill,
): Promise<void> {
  try {
    kill(-preview.pid, "SIGKILL");
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ESRCH"
    ) {
      throw error;
    }
  }
  await preview.closed;
}

test("hashTree is stable across mtimes and rejects link-based trees", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "candidate-tree-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "nested"));
  await writeFile(
    join(root, "nested", "index.html"),
    "<main>candidate</main>\n",
  );
  await writeFile(join(root, "asset.txt"), "asset\n");
  const first = await hashTree(root);

  await utimes(
    join(root, "nested", "index.html"),
    1_700_000_000,
    1_700_000_000,
  );
  await utimes(join(root, "asset.txt"), 1_700_000_001, 1_700_000_001);
  assert.equal(await hashTree(root), first);

  await symlink("asset.txt", join(root, "linked.txt"));
  await assert.rejects(hashTree(root), /enlace simbólico|symlink/i);
  await rm(join(root, "linked.txt"));

  await link(join(root, "asset.txt"), join(root, "hard-linked.txt"));
  await assert.rejects(hashTree(root), /hardlink|enlace.*duro/i);
});

test("creates a clean direct-child candidate with only approved output and immutable evidence", async () => {
  await withCandidateFixture({}, async (fixture) => {
    const candidate = await createCandidate(candidateInput(fixture));

    assert.match(candidate.candidateCommit, /^[a-f0-9]{64}$/u);
    assert.equal(
      await git(fixture.repositoryRoot, [
        "rev-parse",
        `refs/comunidadsolar/candidates/${changeId}/${attemptId}`,
      ]),
      candidate.candidateCommit,
    );
    assert.equal(
      await git(fixture.repositoryRoot, [
        "rev-parse",
        `${candidate.candidateCommit}^`,
      ]),
      fixture.plan.baselineCommit,
    );
    assert.deepEqual(
      (
        await git(fixture.repositoryRoot, [
          "diff",
          "--name-only",
          `${fixture.plan.baselineCommit}..${candidate.candidateCommit}`,
        ])
      )
        .split("\n")
        .filter(Boolean),
      fixture.output.files,
    );
    assert.deepEqual(candidate.files, fixture.output.files);
    assert.deepEqual(candidate.routes, [fixture.plan.targetPath]);
    assert.deepEqual(candidate.buildProfile, fixture.plan.publication);
    assert.ok(candidate.validations.length > fixture.validations.length);
    assert.ok(
      candidate.validations.every(
        (validation) =>
          validation.status === "passed" &&
          validation.evidence.length > 0 &&
          /^[a-f0-9]{64}$/u.test(validation.evidenceSha256 ?? ""),
      ),
    );
    assert.ok(
      candidate.artifacts.some((artifact) =>
        artifact.path.endsWith("/bundle/dist/_worker.js/index.js"),
      ),
    );
    assert.ok(
      candidate.artifacts.some((artifact) =>
        artifact.path.endsWith("/bundle/dist/.prerender/wrangler.json"),
      ),
    );
    assert.ok(
      candidate.artifacts.some((artifact) =>
        artifact.path.endsWith("/bundle/.wrangler/deploy/config.json"),
      ),
    );
    await assert.doesNotReject(verifyCandidateArtifact(candidate));
  });
});

test("keeps candidate A reachable from the controller repository after its private checkout is removed", async () => {
  await withCandidateFixture({}, async (fixture) => {
    const candidate = await createCandidate(candidateInput(fixture));

    await assert.doesNotReject(
      git(fixture.repositoryRoot, [
        "cat-file",
        "-e",
        `${candidate.candidateCommit}^{commit}`,
      ]),
    );
    assert.equal(
      await git(fixture.repositoryRoot, [
        "rev-parse",
        `refs/comunidadsolar/candidates/${changeId}/${attemptId}`,
      ]),
      candidate.candidateCommit,
    );
  });
});

test("reloads and rehashes durable state without restoring preview authority", async () => {
  await withCandidateFixture({}, async (fixture) => {
    const candidate = await createCandidate(candidateInput(fixture));
    await releaseControllerCandidateStore(fixture.store);
    const reloadedStore = await openFixtureCandidateStore(
      fixture.repositoryRoot,
    );
    const reloaded = await loadCandidate({
      store: reloadedStore,
      changeId,
      attemptId,
    });
    assert.deepEqual(reloaded, candidate);
    await assert.doesNotReject(verifyCandidateArtifact(reloaded));
    await assert.rejects(
      startCandidatePreview(reloaded),
      /capability de preview/i,
    );

    await writeFile(
      join(
        fixture.repositoryRoot,
        ".artifacts",
        "candidates",
        changeId,
        attemptId,
        "bundle",
        "dist",
        "index.html",
      ),
      "durable bundle changed\n",
    );
    await assert.rejects(
      loadCandidate({
        store: reloadedStore,
        changeId,
        attemptId,
      }),
      /digest|artefacto/i,
    );
  });
});

test("reloads durable state from a fresh controller store after staging is released", async () => {
  await withCandidateFixture({}, async (fixture) => {
    const candidate = await createCandidate(candidateInput(fixture));
    await releaseControllerCandidateStore(fixture.store);
    await removeStagedAgentOutput(fixture.output);

    const freshStore = await openFixtureCandidateStore(fixture.repositoryRoot);
    const reloaded = await loadCandidate({
      store: freshStore,
      changeId,
      attemptId,
    });
    assert.deepEqual(reloaded, candidate);
    await assert.doesNotReject(verifyCandidateArtifact(reloaded));
  });
});

test("rejects a forged controller candidate store before candidate creation", async () => {
  await withCandidateFixture({}, async (fixture) => {
    await assert.rejects(
      createCandidate({
        ...candidateInput(fixture),
        store: Object.freeze({}),
      } as unknown as CandidateCreationInput),
      /store|controlador/i,
    );
  });
});

test("rejects a controller store opened for another repository", async (t) => {
  const otherRepository = await mkdtemp(
    join(tmpdir(), "candidate-other-store-"),
  );
  t.after(
    async () => await rm(otherRepository, { recursive: true, force: true }),
  );
  await execFileAsync("git", [
    "init",
    "--quiet",
    "--object-format=sha256",
    "--initial-branch=main",
    otherRepository,
  ]);
  const mismatchedStore = await openFixtureCandidateStore(otherRepository);
  try {
    await withCandidateFixture({}, async (fixture) => {
      await assert.rejects(
        createCandidate({
          ...candidateInput(fixture),
          store: mismatchedStore,
        }),
        /store|repositorio|controlador/i,
      );
    });
  } finally {
    await releaseControllerCandidateStore(mismatchedStore).catch(
      () => undefined,
    );
  }
});

test("candidate public modules expose no raw root, checkout, or bundle helpers", async () => {
  const [policy, manifest] = await Promise.all([
    import("../../src/ingest/workspaces/policy.ts"),
    import("../../src/ingest/candidate/manifest.ts"),
  ]);
  assert.equal("controllerCandidateRepositoryRoot" in policy, false);
  assert.equal("withControllerCandidateCheckout" in policy, false);
  assert.equal("createControllerCandidateCheckout" in policy, false);
  assert.equal("assertControllerCandidateStoreOutput" in policy, false);
  assert.equal("copyCandidateBundle" in manifest, false);
  assert.equal("readCandidateBundleConfiguration" in manifest, false);
});

test("candidate public test seams expose neither raw store roots nor preview process details", async () => {
  const [manifest, preview, manifestSource, previewSource] = await Promise.all([
    import("../../src/ingest/candidate/manifest.ts"),
    import("../../src/ingest/candidate/preview.ts"),
    readFile(
      new URL("../../src/ingest/candidate/manifest.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../src/ingest/candidate/preview.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.equal(
    "createControllerCandidateStoreTestInitialization" in manifest,
    false,
  );
  assert.equal("candidateTestInspection" in manifest, false);
  assert.equal("createCandidateTestInspectionCapability" in manifest, false);
  assert.equal("FixedPreviewInvocation" in preview, false);
  assert.doesNotMatch(
    manifestSource,
    /export (?:interface |function )?(?:FixedPreviewInvocation|CandidateTestInspectionCapability|createControllerCandidateStoreTestInitialization|candidateTestInspection|createCandidateTestInspectionCapability)/u,
  );
  assert.doesNotMatch(previewSource, /FixedPreviewInvocation/u);
});

test("candidate reload exposes only durable store identity", async () => {
  const source = await readFile(
    new URL("../../src/ingest/candidate/manifest.ts", import.meta.url),
    "utf8",
  );
  const declaration = source.match(
    /export interface CandidateLoadInput \{([\s\S]*?)\n\}/u,
  );
  assert.notEqual(declaration, null);
  assert.deepEqual(
    [...declaration![1].matchAll(/^\x20{2}readonly ([A-Za-z]+)\??:/gmu)].map(
      (match) => match[1],
    ),
    ["store", "changeId", "attemptId"],
  );
});

test("rejects forged, failed, mismatched and mutated preliminary inputs before Git or build", async () => {
  await withCandidateFixture({}, async (fixture) => {
    const build = createCandidateBuildTestCapability(
      candidateBuildFixture(fixture.plan),
    );
    const input = { ...candidateInput(fixture), buildCapability: build };
    await assert.rejects(
      createCandidate({ ...input, output: { ...fixture.output } }),
      /staging|controlador|store/i,
    );
    await assert.rejects(
      createCandidate({
        ...input,
        preliminaryValidations: fixture.validations.map((validation) => ({
          ...validation,
          status: "failed" as const,
        })),
      }),
      /preliminar|evidencia|validación/i,
    );
    await assert.rejects(
      createCandidate({ ...input, attemptId: "attempt-000002" }),
      /intento|staging|store/i,
    );
    await assert.rejects(
      createCandidate({
        ...input,
        plan: { ...fixture.plan, planSha256: "0".repeat(64) },
      }),
      /plan|staging|preliminar|store/i,
    );
    await writeFile(
      join(fixture.output.path, ...fixture.output.files[0]!.split("/")),
      "mutated after validation\n",
    );
    await assert.rejects(createCandidate(input), /hash|staging|aprobada/i);
  });
});

test("rejects controller-minted preliminary failed and skipped results before build", async () => {
  await withCandidateFixture(
    {},
    async (fixture) => {
      const build = createCandidateBuildTestCapability(
        candidateBuildFixture(fixture.plan),
      );
      assert.ok(
        fixture.validations.some(
          (validation) => validation.status === "failed",
        ),
      );
      assert.ok(
        fixture.validations.some(
          (validation) => validation.status === "skipped",
        ),
      );
      await assert.rejects(
        createCandidate({ ...candidateInput(fixture), buildCapability: build }),
        /únicamente aprobadas|preliminar/i,
      );
    },
    (command) =>
      command.id === "format"
        ? { ...passingResult(command), exitCode: 1, stderr: "fixture failure" }
        : passingResult(command),
  );
});

test("rejects a mismatched build profile or escaping deploy redirect before copying artifacts", async () => {
  await withCandidateFixture(
    { targetEnvironment: "another-environment" },
    async (fixture) => {
      await assert.rejects(
        createCandidate(candidateInput(fixture)),
        /perfil|environment|build/i,
      );
    },
  );
  await withCandidateFixture(
    {
      redirect:
        '{"configPath":"../../../../outside/wrangler.json","auxiliaryWorkers":[]}',
    },
    async (fixture) => {
      await assert.rejects(
        createCandidate(candidateInput(fixture)),
        /escapa|redirect|config/i,
      );
    },
  );
  await withCandidateFixture({ bindings: ["ASSETS"] }, async (fixture) => {
    await assert.rejects(
      createCandidate(candidateInput(fixture)),
      /bindings|perfil/i,
    );
  });
});

test("refuses a build that mutates tracked candidate A bytes", async () => {
  await withCandidateFixture({}, async (fixture) => {
    const build = createCandidateBuildTestCapability(
      candidateBuildFixture(fixture.plan, {}, { "README.md": "mutated\n" }),
    );
    await assert.rejects(
      createCandidate({ ...candidateInput(fixture), buildCapability: build }),
      /inmutable|worktree|checkout|cambios no aprobados/i,
    );
  });
});

test("refuses an unexpected untracked build file before artifact copy or preview", async () => {
  await withCandidateFixture({}, async (fixture) => {
    const build = createCandidateBuildTestCapability(
      candidateBuildFixture(
        fixture.plan,
        {},
        {
          "unexpected.txt": "must never be accepted\n",
        },
      ),
    );
    await assert.rejects(
      createCandidate({ ...candidateInput(fixture), buildCapability: build }),
      /no aprobado|untracked|checkout|inmutable/i,
    );
  });
});

test("refuses ignored .wrangler output other than the fixed deploy config", async () => {
  await withCandidateFixture({}, async (fixture) => {
    const build = createCandidateBuildTestCapability(
      candidateBuildFixture(
        fixture.plan,
        {},
        {
          ".wrangler/deploy/unexpected.txt": "must never be accepted\n",
        },
      ),
    );
    await assert.rejects(
      createCandidate({ ...candidateInput(fixture), buildCapability: build }),
      /output.*no aprobado|deploy/i,
    );
  });
});

test("fails closed when the controller has no build or preview capability", async () => {
  await withCandidateFixture({}, async (fixture) => {
    await assert.rejects(
      createCandidate({
        ...candidateInput(fixture),
        buildCapability: undefined,
      }),
      /capability de build/i,
    );
    const candidate = await createCandidate(candidateInput(fixture));
    await assert.rejects(
      startCandidatePreview(candidate),
      /capability de preview/i,
    );
  });
});

test("rehashes the copied bundle and refuses a changed output byte", async () => {
  await withCandidateFixture({}, async (fixture) => {
    const candidate = await createCandidate(candidateInput(fixture));
    await writeFile(
      join(
        fixtureCandidateBundlePath(fixture.repositoryRoot),
        "dist",
        "index.html",
      ),
      "changed\n",
    );
    await assert.rejects(
      verifyCandidateArtifact(candidate),
      /digest no coincide/i,
    );
  });
});

test("previews only the verified copied bundle through a semantic descriptor and kills its group", async (t) => {
  await withCandidateFixture({}, async (fixture) => {
    await installFixtureWrangler(fixture.repositoryRoot);
    let descriptor: PreviewAssertionDescriptor | undefined;
    let previewPid: number | undefined;
    const preview = createCandidatePreviewTestCapability(async (current) => {
      descriptor = current;
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const http=require('node:http');const server=http.createServer((_,res)=>res.end('ok'));server.listen(0,'127.0.0.1',()=>console.log(server.address().port));`,
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const port = await new Promise<string>((resolvePort, rejectPort) => {
        let output = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          const match = output.match(/^(\d+)\n/u);
          if (match?.[1] !== undefined) resolvePort(match[1]);
        });
        child.once("error", rejectPort);
        child.once("exit", (code) => {
          if (code !== 0)
            rejectPort(new Error(`fixture preview exited ${code}`));
        });
      });
      previewPid = child.pid;
      return { child, url: `http://127.0.0.1:${port}` };
    });
    const candidate = await createCandidate(candidateInput(fixture, preview));
    const handle = await startCandidatePreview(candidate);
    t.after(async () => await handle.stop().catch(() => undefined));
    assert.deepEqual(descriptor, {
      publisher: "local",
      candidateCommit: candidate.candidateCommit,
      artifactSha256: candidate.artifactSha256,
      sealedBundle: true,
      fixedLocalArguments: true,
      localOnly: true,
    });
    assert.deepEqual(Object.keys(descriptor ?? {}).sort(), [
      "artifactSha256",
      "candidateCommit",
      "fixedLocalArguments",
      "localOnly",
      "publisher",
      "sealedBundle",
    ]);
    const response = await fetch(handle.url);
    assert.equal(response.status, 200);
    await handle.stop();
    const stoppedPid = previewPid;
    if (stoppedPid !== undefined) {
      await assert.rejects(
        async () => process.kill(stoppedPid, 0),
        /ESRCH|no such process/i,
      );
    }
  });
});

test(
  "reaps an owned zombie preview leader before interpreting post-TERM EPERM",
  { skip: process.platform === "win32" },
  async (t) => {
    let previewPid: number | undefined;
    t.after(() => {
      if (previewPid === undefined) return;
      try {
        process.kill(-previewPid, "SIGKILL");
      } catch {
        // The passing cleanup has already removed the owned group.
      }
    });
    await withCandidateFixture({}, async (fixture) => {
      await installFixtureWrangler(fixture.repositoryRoot);
      let closed: Promise<void> | undefined;
      const preview = createCandidatePreviewTestCapability(async () => {
        const child = spawn(
          process.execPath,
          ["-e", "setInterval(() => undefined, 1_000);"],
          { detached: true, stdio: "ignore" },
        );
        previewPid = child.pid;
        closed = new Promise<void>((resolveClosed) => {
          child.once("close", () => resolveClosed());
        });
        return { child, url: "http://127.0.0.1:43124" };
      });
      const candidate = await createCandidate(candidateInput(fixture, preview));
      const handle = await startCandidatePreview(candidate);

      await assert.doesNotReject(handle.stop());
      await closed;
      assert.ok(previewPid !== undefined);
      assert.throws(() => process.kill(previewPid!, 0), /ESRCH/u);
    });
  },
);

test(
  "forces present, TERM, EPERM, owned reap, then ESRCH for preview cleanup",
  { skip: process.platform === "win32" },
  async (t) => {
    let reaped = false;
    await withCandidateFixture({}, async (fixture) => {
      const preview = await startDetachedPreview(fixture, () => {
        reaped = true;
      });
      const originalKill = process.kill.bind(process);
      const signals: ProcessGroupSignal[] = [];
      let probes = 0;
      try {
        interceptPreviewProcessGroup(t, preview.pid, (signal) => {
          signals.push(signal);
          if (signal === "SIGTERM") {
            return originalKill(-preview.pid, signal);
          }
          assert.equal(signal, 0);
          probes += 1;
          if (probes === 1) return true;
          if (probes === 2) throw processGroupError("EPERM");
          if (probes === 3) {
            assert.equal(reaped, true);
            throw processGroupError("ESRCH");
          }
          assert.fail(`sondeo de grupo inesperado: ${probes.toString()}`);
        });

        await assert.doesNotReject(preview.handle.stop());
        await preview.closed;
        assert.deepEqual(signals, [0, "SIGTERM", 0, 0]);
        assert.equal(reaped, true);
        assert.throws(() => originalKill(-preview.pid, 0), { code: "ESRCH" });
      } finally {
        t.mock.restoreAll();
        await reapDetachedPreview(preview, originalKill);
      }
    });
  },
);

test(
  "fails closed when the initial preview group probe is EPERM",
  { skip: process.platform === "win32" },
  async (t) => {
    await withCandidateFixture({}, async (fixture) => {
      const preview = await startDetachedPreview(fixture);
      const originalKill = process.kill.bind(process);
      const signals: ProcessGroupSignal[] = [];
      try {
        interceptPreviewProcessGroup(t, preview.pid, (signal) => {
          signals.push(signal);
          throw processGroupError("EPERM");
        });

        await assert.rejects(
          preview.handle.stop(),
          /No se pudo verificar el grupo de preview candidato antes de detenerlo/i,
        );
        assert.deepEqual(signals, [0]);
      } finally {
        t.mock.restoreAll();
        await reapDetachedPreview(preview, originalKill);
      }
    });
  },
);

test(
  "fails closed when EPERM persists after the owned preview child reaps",
  { skip: process.platform === "win32" },
  async (t) => {
    let reaped = false;
    await withCandidateFixture({}, async (fixture) => {
      const preview = await startDetachedPreview(fixture, () => {
        reaped = true;
      });
      const originalKill = process.kill.bind(process);
      const signals: ProcessGroupSignal[] = [];
      let probes = 0;
      try {
        interceptPreviewProcessGroup(t, preview.pid, (signal) => {
          signals.push(signal);
          if (signal === "SIGTERM") {
            return originalKill(-preview.pid, signal);
          }
          assert.equal(signal, 0);
          probes += 1;
          if (probes === 1) return true;
          if (probes === 2) throw processGroupError("EPERM");
          if (probes === 3) {
            assert.equal(reaped, true);
            throw processGroupError("EPERM");
          }
          assert.fail(`sondeo de grupo inesperado: ${probes.toString()}`);
        });

        await assert.rejects(
          preview.handle.stop(),
          /No se pudo verificar que el grupo de preview candidato terminara/i,
        );
        await preview.closed;
        assert.deepEqual(signals, [0, "SIGTERM", 0, 0]);
        assert.equal(reaped, true);
      } finally {
        t.mock.restoreAll();
        await reapDetachedPreview(preview, originalKill);
      }
    });
  },
);

test(
  "keeps a live preview group on TERM until group SIGKILL confirms descendant cleanup",
  { skip: process.platform === "win32" },
  async (t) => {
    await withCandidateFixture({}, async (fixture) => {
      const preview = await startDetachedPreview(fixture);
      const originalKill = process.kill.bind(process);
      const signals: ProcessGroupSignal[] = [];
      let killed = false;
      try {
        interceptPreviewProcessGroup(t, preview.pid, (signal) => {
          signals.push(signal);
          if (signal === 0) {
            if (killed) throw processGroupError("ESRCH");
            return true;
          }
          if (signal === "SIGTERM") {
            // Keep the simulated group alive, like a surviving descendant.
            return true;
          }
          if (signal === "SIGKILL") {
            killed = true;
            return originalKill(-preview.pid, signal);
          }
          assert.fail(`señal de grupo inesperada: ${String(signal)}`);
        });

        await assert.doesNotReject(preview.handle.stop());
        await preview.closed;
        assert.equal(signals[0], 0);
        assert.equal(signals[1], "SIGTERM");
        assert.equal(signals.at(-2), "SIGKILL");
        assert.equal(signals.at(-1), 0);
        assert.ok(signals.filter((signal) => signal === 0).length > 2);
        assert.throws(() => originalKill(-preview.pid, 0), { code: "ESRCH" });
      } finally {
        t.mock.restoreAll();
        await reapDetachedPreview(preview, originalKill);
      }
    });
  },
);

test("preview resolves Wrangler from its sealed store root after cwd changes", async (t) => {
  const otherRoot = await mkdtemp(join(tmpdir(), "candidate-preview-cwd-"));
  const initialCwd = process.cwd();
  t.after(async () => {
    if (process.cwd() !== initialCwd) process.chdir(initialCwd);
    await rm(otherRoot, { recursive: true, force: true });
  });
  await withCandidateFixture({}, async (fixture) => {
    const trustedRoot = await realpath(fixture.repositoryRoot);
    await installFixtureWrangler(trustedRoot);

    let descriptor: PreviewAssertionDescriptor | undefined;
    let handle: Awaited<ReturnType<typeof startCandidatePreview>> | undefined;
    const preview = createCandidatePreviewTestCapability(async (current) => {
      descriptor = current;
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => undefined, 1_000);"],
        { detached: true, stdio: "ignore" },
      );
      return { child, url: "http://127.0.0.1:43123" };
    });
    const candidate = await createCandidate(candidateInput(fixture, preview));
    process.chdir(otherRoot);
    try {
      handle = await startCandidatePreview(candidate);
      assert.deepEqual(descriptor, {
        publisher: "local",
        candidateCommit: candidate.candidateCommit,
        artifactSha256: candidate.artifactSha256,
        sealedBundle: true,
        fixedLocalArguments: true,
        localOnly: true,
      });
    } finally {
      await handle?.stop().catch(() => undefined);
      process.chdir(initialCwd);
    }
  });
});

test("rechecks an escaped deploy redirect changed after verification before preview spawn", async () => {
  await withCandidateFixture({}, async (fixture) => {
    let spawns = 0;
    const preview = createCandidatePreviewTestCapability(async () => {
      spawns += 1;
      throw new Error("the preview adapter must not be reached");
    });
    const candidate = await createCandidate(candidateInput(fixture, preview));
    await verifyCandidateArtifact(candidate);
    await writeFile(
      join(
        fixtureCandidateBundlePath(fixture.repositoryRoot),
        ".wrangler",
        "deploy",
        "config.json",
      ),
      '{"configPath":"../../../../escape/wrangler.json","auxiliaryWorkers":[]}',
    );
    await assert.rejects(
      startCandidatePreview(candidate),
      /digest|config|escapa/i,
    );
    assert.equal(spawns, 0);
  });
});
