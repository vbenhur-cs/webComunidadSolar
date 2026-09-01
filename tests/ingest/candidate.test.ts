import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { sha256Canonical } from "../../src/ingest/canonical-json.ts";
import {
  candidateTestInspection,
  createCandidate,
  createCandidateArtifactStore,
  createCandidateTestInspectionCapability,
  loadCandidate,
  removeCandidateArtifactStore,
  verifyCandidateArtifact,
  type CandidateArtifactStore,
  type CandidateCreationInput,
  type CandidateTestInspectionCapability,
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
  type FixedPreviewInvocation,
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
  const config = JSON.stringify({
    targetEnvironment,
    main: "_worker.js/index.js",
    assets: { binding: "ASSETS", directory: ".", run_worker_first: true },
    vars: { SITE_INDEXABLE: siteIndexable ? "true" : "false" },
    bindings,
  });
  const nestedConfig = JSON.stringify({
    targetEnvironment,
    main: "../_worker.js/index.js",
    assets: { binding: "ASSETS", directory: "..", run_worker_first: true },
    vars: { SITE_INDEXABLE: siteIndexable ? "true" : "false" },
    bindings,
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
  readonly artifactStore: CandidateArtifactStore;
  readonly build: CandidateBuildTestCapability;
  readonly inspection: CandidateTestInspectionCapability;
}

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
  let artifactStore: CandidateArtifactStore | undefined;
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
    artifactStore = await createCandidateArtifactStore(output, plan, attemptId);
    const build = createCandidateBuildTestCapability(
      candidateBuildFixture(plan, buildOptions),
    );
    await run({
      repositoryRoot,
      output,
      plan,
      validations,
      artifactStore,
      build,
      inspection: createCandidateTestInspectionCapability(),
    });
  } finally {
    if (artifactStore !== undefined) {
      await removeCandidateArtifactStore(artifactStore).catch(() => undefined);
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
    artifactStore: fixture.artifactStore,
    buildCapability: fixture.build,
    ...(preview === undefined ? {} : { previewCapability: preview }),
  };
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
          validation.status === "passed" && validation.evidence.length > 0,
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

test("reloads and rehashes the durable controller bundle without a checkout path", async () => {
  await withCandidateFixture({}, async (fixture) => {
    const candidate = await createCandidate(candidateInput(fixture));
    await removeCandidateArtifactStore(fixture.artifactStore);
    const reloaded = await loadCandidate({
      output: fixture.output,
      plan: fixture.plan,
      attemptId,
    });
    assert.deepEqual(reloaded, candidate);
    await assert.doesNotReject(verifyCandidateArtifact(reloaded));

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
        output: fixture.output,
        plan: fixture.plan,
        attemptId,
      }),
      /digest|artefacto/i,
    );
  });
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
    const inspection = candidateTestInspection(fixture.inspection, candidate);
    await writeFile(
      join(inspection.bundlePath, "dist", "index.html"),
      "changed\n",
    );
    await assert.rejects(
      verifyCandidateArtifact(candidate),
      /digest no coincide/i,
    );
  });
});

test("previews only the verified copied bundle with fixed local Wrangler argv and kills its group", async (t) => {
  await withCandidateFixture({}, async (fixture) => {
    let invocation: FixedPreviewInvocation | undefined;
    const preview = createCandidatePreviewTestCapability(async (current) => {
      invocation = current;
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
      return { child, url: `http://127.0.0.1:${port}` };
    });
    const candidate = await createCandidate(candidateInput(fixture, preview));
    const handle = await startCandidatePreview(candidate);
    t.after(async () => await handle.stop().catch(() => undefined));
    assert.ok(invocation !== undefined);
    assert.equal(invocation?.argv[1], "dev");
    assert.ok(invocation?.argv.includes("--no-bundle"));
    assert.ok(invocation?.argv.includes("--assets"));
    assert.ok(invocation?.argv.includes("--config"));
    assert.ok(invocation?.argv.includes("--local"));
    assert.ok(
      invocation?.argv.every((argument) => !argument.includes("build")),
    );
    const response = await fetch(handle.url);
    assert.equal(response.status, 200);
    const previewPid = candidateTestInspection(
      fixture.inspection,
      candidate,
    ).previewPid;
    await handle.stop();
    if (previewPid !== undefined) {
      await assert.rejects(
        async () => process.kill(previewPid, 0),
        /ESRCH|no such process/i,
      );
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
    const inspection = candidateTestInspection(fixture.inspection, candidate);
    await writeFile(
      join(inspection.bundlePath, ".wrangler", "deploy", "config.json"),
      '{"configPath":"../../../../escape/wrangler.json","auxiliaryWorkers":[]}',
    );
    await assert.rejects(
      startCandidatePreview(candidate),
      /digest|config|escapa/i,
    );
    assert.equal(spawns, 0);
  });
});
