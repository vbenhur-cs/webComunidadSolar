import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createFixtureApprovalRun,
  type FixtureApprovalRun,
} from "../../src/ingest/approvals/prompt.ts";
import {
  approveGate1,
  approveGate2,
} from "../../src/ingest/approvals/service.ts";
import { sha256Canonical } from "../../src/ingest/canonical-json.ts";
import { openIngestionControllerForTest } from "../../src/ingest/controller.ts";
import { createSanitizedCandidateDossier } from "../../src/ingest/dossier.ts";
import type {
  ApprovalRecord,
  AttemptRecord,
  CandidateManifest,
  ChangePlan,
  NormalizedRequest,
} from "../../src/ingest/domain.ts";
import { ingestPaths } from "../../src/ingest/paths.ts";
import { createStateStore } from "../../src/ingest/state-store.ts";
import {
  createFixtureControllerRuntime,
  parseFixtureInvocation,
  runFixtureE2e,
} from "../fixtures/ingestion/run-e2e.ts";

const execFileAsync = promisify(execFile);

process.env.INGEST_TEST_MODE ??= "true";

async function withTemporaryMainClone<T>(
  operation: (root: string) => Promise<T>,
): Promise<T> {
  const source = process.cwd();
  const root = await mkdtemp(
    join(tmpdir(), "comunidadsolar-ingestion-e2e-test-"),
  );
  const clone = join(root, "source");
  const head = await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  try {
    await execFileAsync(
      "git",
      ["clone", "--no-hardlinks", "--quiet", source, clone],
      {
        encoding: "utf8",
      },
    );
    await execFileAsync(
      "git",
      ["-C", clone, "checkout", "--quiet", "-B", "main", head.stdout.trim()],
      { encoding: "utf8" },
    );
    return await operation(clone);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function approveFixtureGate1(
  repositoryRoot: string,
  fixture: FixtureApprovalRun,
  changeId: string,
): Promise<void> {
  const plan = JSON.parse(
    await readFile(
      join(repositoryRoot, ".change-state", changeId, "plan.json"),
      "utf8",
    ),
  ) as ChangePlan;
  const prompt = await fixture.createPrompt({
    isTTY: true,
    answer: plan.planSha256.slice(0, 12),
  });
  const paths = await ingestPaths(changeId, { projectRoot: repositoryRoot });
  const approval = await approveGate1(
    {
      ...paths,
      plan,
      actor: "test-human",
      repositoryRoot,
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    },
    prompt,
  );
  await createStateStore({ projectRoot: repositoryRoot }).transition(changeId, {
    type: "gate1-approved",
    to: "gate1_approved",
    payload: { gate: approval.gate, subjectSha256: approval.subjectSha256 },
  });
}

async function approveFixtureGate2(
  repositoryRoot: string,
  fixture: FixtureApprovalRun,
  changeId: string,
): Promise<void> {
  const [plan, candidate] = await Promise.all([
    readFile(
      join(repositoryRoot, ".change-state", changeId, "plan.json"),
      "utf8",
    ),
    readFile(
      join(repositoryRoot, ".change-state", changeId, "candidate.json"),
      "utf8",
    ),
  ]);
  const approvedPlan = JSON.parse(plan) as ChangePlan;
  const approvedCandidate = JSON.parse(candidate) as CandidateManifest;
  const prompt = await fixture.createPrompt({
    isTTY: true,
    answer: sha256Canonical(approvedCandidate).slice(0, 12),
  });
  const paths = await ingestPaths(changeId, { projectRoot: repositoryRoot });
  const approval = await approveGate2(
    {
      ...paths,
      plan: approvedPlan,
      candidate: approvedCandidate,
      actor: "test-human",
      repositoryRoot,
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    },
    prompt,
  );
  await createStateStore({ projectRoot: repositoryRoot }).transition(changeId, {
    type: "gate2-approved",
    to: "gate2_approved",
    payload: { gate: approval.gate, subjectSha256: approval.subjectSha256 },
  });
}

async function waitForRecordedStarts(
  path: string,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const starts = (await readFile(path, "utf8"))
        .split("\n")
        .filter((value) => value !== "");
      if (starts.length >= expected) return;
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("the command fixture did not start in time");
}

async function createSlowCommandAgent(
  root: string,
  recorder: string,
): Promise<string> {
  const source = await readFile(
    join(process.cwd(), "tests/fixtures/ingestion/e2e-command-agent.mjs"),
    "utf8",
  );
  const delayed = source
    .replace(
      'import { mkdir, readFile, writeFile } from "node:fs/promises";',
      'import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";',
    )
    .replace(
      'let input = "";',
      `await appendFile(${JSON.stringify(recorder)}, "started\\n", "utf8");\nawait new Promise((resolveWait) => setTimeout(resolveWait, 350));\n\nlet input = "";`,
    );
  const path = join(root, "slow-command-agent.mjs");
  await writeFile(path, delayed, "utf8");
  return path;
}

async function withValidatedFixture<T>(
  operation: (input: {
    readonly clone: string;
    readonly fixture: FixtureApprovalRun;
    readonly controller: Awaited<
      ReturnType<typeof openIngestionControllerForTest>
    >;
  }) => Promise<T>,
): Promise<T> {
  const previousCwd = process.cwd();
  const previousCommandConfig = process.env.INGEST_COMMAND_AGENT_CONFIG;
  process.env.INGEST_TEST_MODE = "true";
  try {
    return await withTemporaryMainClone(async (sourceClone) => {
      const fixture = await createFixtureApprovalRun({
        fixtureSourceRoot: sourceClone,
      });
      const clone = fixture.repositoryRoot;
      let controller:
        Awaited<ReturnType<typeof openIngestionControllerForTest>> | undefined;
      try {
        process.chdir(clone);
        const planner = await openIngestionControllerForTest({});
        try {
          await planner.receiveRequest({
            kind: "request",
            source: join(
              clone,
              "tests/fixtures/ingestion/detailed-request/request.yaml",
            ),
          });
          await planner.plan("nueva-pagina-autoconsumo");
        } finally {
          await planner.dispose();
        }
        await approveFixtureGate1(clone, fixture, "nueva-pagina-autoconsumo");
        const plan = JSON.parse(
          await readFile(
            join(
              clone,
              ".change-state",
              "nueva-pagina-autoconsumo",
              "plan.json",
            ),
            "utf8",
          ),
        ) as ChangePlan;
        process.env.INGEST_COMMAND_AGENT_CONFIG = JSON.stringify({
          command: process.execPath,
          args: [
            join(previousCwd, "tests/fixtures/ingestion/e2e-command-agent.mjs"),
          ],
        });
        controller = await openIngestionControllerForTest(
          createFixtureControllerRuntime(plan),
        );
        const generated = await controller.generate({
          changeId: "nueva-pagina-autoconsumo",
          adapter: "command",
        });
        assert.equal(generated.kind, "success");
        const validated = await controller.validate("nueva-pagina-autoconsumo");
        assert.equal(validated.kind, "success");
        return await operation({ clone, fixture, controller });
      } finally {
        await controller?.dispose().catch(() => undefined);
        await fixture.dispose();
      }
    });
  } finally {
    process.chdir(previousCwd);
    if (previousCommandConfig === undefined)
      delete process.env.INGEST_COMMAND_AGENT_CONFIG;
    else process.env.INGEST_COMMAND_AGENT_CONFIG = previousCommandConfig;
  }
}

async function writeFixtureDossier(
  repositoryRoot: string,
  changeId: string,
): Promise<void> {
  const root = join(repositoryRoot, ".change-state", changeId);
  const [request, plan, gate1, gate2, attempt, candidate] = await Promise.all([
    readFile(join(root, "request.json"), "utf8"),
    readFile(join(root, "plan.json"), "utf8"),
    readFile(join(root, "approvals", "gate-1.json"), "utf8"),
    readFile(join(root, "approvals", "gate-2.json"), "utf8"),
    readFile(join(root, "attempts", "attempt-000001.json"), "utf8"),
    readFile(join(root, "candidate.json"), "utf8"),
  ]);
  const dossier = createSanitizedCandidateDossier({
    request: JSON.parse(request) as NormalizedRequest,
    plan: JSON.parse(plan) as ChangePlan,
    gate1: JSON.parse(gate1) as ApprovalRecord,
    gate2: JSON.parse(gate2) as ApprovalRecord,
    attempt: JSON.parse(attempt) as AttemptRecord,
    candidate: JSON.parse(candidate) as CandidateManifest,
  });
  const destination = join(
    repositoryRoot,
    ".artifacts",
    "ingestion-fixtures",
    changeId,
  );
  for (const file of dossier.files) {
    const target = join(destination, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, "utf8");
  }
}

test("fixture E2E parser accepts exactly the closed non-record matrix", () => {
  assert.deepEqual(
    parseFixtureInvocation([
      "--fixture",
      "detailed-request",
      "--mode",
      "blocks",
      "--change-id",
      "fixture-request-blocks",
    ]),
    {
      fixture: "detailed-request",
      mode: "blocks",
      changeId: "fixture-request-blocks",
      record: false,
    },
  );
  assert.deepEqual(
    parseFixtureInvocation([
      "--fixture",
      "detailed-request",
      "--mode",
      "hybrid",
      "--change-id",
      "fixture-request-hybrid",
    ]),
    {
      fixture: "detailed-request",
      mode: "hybrid",
      changeId: "fixture-request-hybrid",
      record: false,
    },
  );
  assert.deepEqual(
    parseFixtureInvocation([
      "--fixture",
      "supplied-page",
      "--mode",
      "freeform",
      "--change-id",
      "fixture-page-freeform",
    ]),
    {
      fixture: "supplied-page",
      mode: "freeform",
      changeId: "fixture-page-freeform",
      record: false,
    },
  );
});

test("fixture E2E parser rejects non-matrix and hidden values before any clone can start", () => {
  for (const argv of [
    [
      "--fixture",
      "detailed-request",
      "--mode",
      "freeform",
      "--change-id",
      "fixture-request-blocks",
    ],
    [
      "--fixture",
      "unknown",
      "--mode",
      "blocks",
      "--change-id",
      "fixture-request-blocks",
    ],
    [
      "--fixture",
      "detailed-request",
      "--mode",
      "blocks",
      "--change-id",
      "other",
    ],
    [
      "--fixture",
      "detailed-request",
      "--mode",
      "blocks",
      "--change-id",
      "fixture-request-blocks",
      "--unknown",
    ],
  ]) {
    assert.throws(
      () => parseFixtureInvocation(argv),
      /matriz|opciones|exactamente/i,
    );
  }
});

test("fixture record parsing stays limited to the same three closed combinations", () => {
  assert.equal(
    parseFixtureInvocation([
      "--record",
      "--fixture",
      "supplied-page",
      "--mode",
      "freeform",
      "--change-id",
      "fixture-page-freeform",
    ]).record,
    true,
  );
  assert.throws(
    () =>
      parseFixtureInvocation([
        "--record",
        "--fixture",
        "supplied-page",
        "--mode",
        "blocks",
        "--change-id",
        "fixture-page-freeform",
      ]),
    /matriz/i,
  );
  assert.throws(
    () =>
      parseFixtureInvocation([
        "--fixture",
        "detailed-request",
        "--mode",
        "blocks",
        "--change-id",
        "fixture-request-blocks",
        "--record",
        "--record",
      ]),
    /exactamente|opciones/i,
  );
});

test("fixture E2E revalidates programmatic input before environment, Git or cloning", async () => {
  const previousCwd = process.cwd();
  const previousTestMode = process.env.INGEST_TEST_MODE;
  const outsideRepository = await mkdtemp(join(tmpdir(), "ingestion-not-git-"));
  try {
    process.chdir(outsideRepository);
    process.env.INGEST_TEST_MODE = "true";
    await assert.rejects(
      () =>
        runFixtureE2e({
          fixture: "detailed-request",
          mode: "freeform",
          changeId: "fixture-request-blocks",
          record: false,
        }),
      /matriz/i,
    );
    await assert.rejects(
      () =>
        runFixtureE2e({
          fixture: "detailed-request",
          mode: "blocks",
          changeId: "fixture-request-blocks",
          record: false,
          extra: "not part of the closed invocation",
        } as unknown as Parameters<typeof runFixtureE2e>[0]),
      /matriz|exacta/i,
    );
  } finally {
    process.chdir(previousCwd);
    if (previousTestMode === undefined) delete process.env.INGEST_TEST_MODE;
    else process.env.INGEST_TEST_MODE = previousTestMode;
    await rm(outsideRepository, { recursive: true, force: true });
  }
});

test("fixture record code copies a sanitized dossier and has no external promotion path", async () => {
  const source = await readFile(
    join(process.cwd(), "tests/fixtures/ingestion/run-e2e.ts"),
    "utf8",
  );
  assert.match(source, /createSanitizedCandidateDossier/u);
  assert.match(source, /dossier\.files/u);
  assert.doesNotMatch(source, /CloudflarePublisher|\bmerge\b|--execute/u);
});

test("fixture record source stages an exact dossier before an identity-bound tag", async () => {
  const source = await readFile(
    join(process.cwd(), "tests/fixtures/ingestion/run-e2e.ts"),
    "utf8",
  );
  assert.match(source, /sanitizedGitEnv/u);
  assert.match(source, /constants\.O_NOFOLLOW/u);
  assert.match(source, /\.ingestion-fixture-staging/u);
  assert.match(source, /verifyStagedDossier/u);
  assert.match(source, /update-ref/u);
  assert.match(source, /check-ignore/u);
  assert.match(source, /candidateCommit/u);
  assert.match(
    source,
    /verifyStagedDossier\([\s\S]*?update-ref/u,
    "the tag update must occur after dossier verification",
  );
  assert.doesNotMatch(source, /\$\{ref\}:\$\{tag\}/u);
});

test("fixture E2E retains preview authority only within its controller session", async () => {
  const previousCwd = process.cwd();
  try {
    const result = await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      return await runFixtureE2e({
        fixture: "detailed-request",
        mode: "blocks",
        changeId: "fixture-request-blocks",
        record: false,
      });
    });
    assert.equal(result.local, "success");
    assert.equal(result.published, false);
    assert.match(result.candidate.artifactSha256, /^[a-f0-9]{64}$/u);
  } finally {
    process.chdir(previousCwd);
  }
});

test("fixture E2E executes every closed matrix entry without recording", async () => {
  const previousCwd = process.cwd();
  const invocations = [
    {
      fixture: "detailed-request" as const,
      mode: "blocks" as const,
      changeId: "fixture-request-blocks",
    },
    {
      fixture: "detailed-request" as const,
      mode: "hybrid" as const,
      changeId: "fixture-request-hybrid",
    },
    {
      fixture: "supplied-page" as const,
      mode: "freeform" as const,
      changeId: "fixture-page-freeform",
    },
  ];
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      for (const invocation of invocations) {
        const result = await runFixtureE2e({ ...invocation, record: false });
        assert.equal(result.changeId, invocation.changeId);
        assert.equal(result.mode, invocation.mode);
        assert.equal(result.local, "success");
        assert.equal(result.published, false);
        assert.match(result.candidate.artifactSha256, /^[a-f0-9]{64}$/u);
      }
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("controller keeps Gate 1 durable when CommandAgent cannot start", async () => {
  const previousCwd = process.cwd();
  const previousCommandConfig = process.env.INGEST_COMMAND_AGENT_CONFIG;
  process.env.INGEST_TEST_MODE = "true";
  delete process.env.INGEST_COMMAND_AGENT_CONFIG;
  try {
    await withTemporaryMainClone(async (sourceClone) => {
      const fixture = await createFixtureApprovalRun({
        fixtureSourceRoot: sourceClone,
      });
      const clone = fixture.repositoryRoot;
      try {
        process.chdir(clone);
        const planner = await openIngestionControllerForTest({});
        try {
          await planner.receiveRequest({
            kind: "request",
            source: join(
              clone,
              "tests/fixtures/ingestion/detailed-request/request.yaml",
            ),
          });
          await planner.plan("nueva-pagina-autoconsumo");
        } finally {
          await planner.dispose();
        }

        await approveFixtureGate1(clone, fixture, "nueva-pagina-autoconsumo");
        const controller = await openIngestionControllerForTest({});
        try {
          await assert.rejects(
            controller.generate({
              changeId: "nueva-pagina-autoconsumo",
              adapter: "command",
            }),
            /No existe una configuración CommandAgent/u,
          );
          const status = await controller.status("nueva-pagina-autoconsumo");
          assert.equal(status.kind, "success");
          assert.equal(status.value.state, "gate1_approved");
          const attempt = JSON.parse(
            await readFile(
              join(
                clone,
                ".change-state",
                "nueva-pagina-autoconsumo",
                "attempts",
                "attempt-000001.json",
              ),
              "utf8",
            ),
          ) as { readonly status: string };
          assert.equal(attempt.status, "failed");
        } finally {
          await controller.dispose();
        }
      } finally {
        await fixture.dispose();
      }
    });
  } finally {
    process.chdir(previousCwd);
    if (previousCommandConfig === undefined)
      delete process.env.INGEST_COMMAND_AGENT_CONFIG;
    else process.env.INGEST_COMMAND_AGENT_CONFIG = previousCommandConfig;
  }
});

test("two controllers serialize one generate attempt before any candidate overwrite", async () => {
  const previousCwd = process.cwd();
  const previousCommandConfig = process.env.INGEST_COMMAND_AGENT_CONFIG;
  const agentRoot = await mkdtemp(join(tmpdir(), "ingestion-generate-race-"));
  const recorder = join(agentRoot, "starts.log");
  let first:
    Awaited<ReturnType<typeof openIngestionControllerForTest>> | undefined;
  let second:
    Awaited<ReturnType<typeof openIngestionControllerForTest>> | undefined;
  let fixture: FixtureApprovalRun | undefined;
  process.env.INGEST_TEST_MODE = "true";
  try {
    const agent = await createSlowCommandAgent(agentRoot, recorder);
    await withTemporaryMainClone(async (sourceClone) => {
      fixture = await createFixtureApprovalRun({
        fixtureSourceRoot: sourceClone,
      });
      const clone = fixture.repositoryRoot;
      process.chdir(clone);
      const planner = await openIngestionControllerForTest({});
      try {
        await planner.receiveRequest({
          kind: "request",
          source: join(
            clone,
            "tests/fixtures/ingestion/detailed-request/request.yaml",
          ),
        });
        await planner.plan("nueva-pagina-autoconsumo");
      } finally {
        await planner.dispose();
      }
      await approveFixtureGate1(clone, fixture, "nueva-pagina-autoconsumo");
      const plan = JSON.parse(
        await readFile(
          join(clone, ".change-state", "nueva-pagina-autoconsumo", "plan.json"),
          "utf8",
        ),
      ) as ChangePlan;
      process.env.INGEST_COMMAND_AGENT_CONFIG = JSON.stringify({
        command: process.execPath,
        args: [agent],
      });
      const runtime = createFixtureControllerRuntime(plan);
      first = await openIngestionControllerForTest(runtime);
      second = await openIngestionControllerForTest(runtime);
      const firstGeneration = first.generate({
        changeId: "nueva-pagina-autoconsumo",
        adapter: "command",
      });
      await waitForRecordedStarts(recorder, 1);
      const secondGeneration = second.generate({
        changeId: "nueva-pagina-autoconsumo",
        adapter: "command",
      });
      const outcomes = await Promise.allSettled([
        firstGeneration,
        secondGeneration,
      ]);
      const starts = (await readFile(recorder, "utf8"))
        .split("\n")
        .filter((value) => value !== "");
      assert.equal(starts.length, 1, "only the lock holder may start an agent");
      assert.equal(
        outcomes.filter((outcome) => outcome.status === "fulfilled").length,
        1,
      );
      const paths = await ingestPaths("nueva-pagina-autoconsumo", {
        projectRoot: clone,
      });
      assert.deepEqual(
        (await readdir(paths.attemptsDir)).filter((entry) =>
          entry.endsWith(".json"),
        ),
        ["attempt-000001.json"],
      );
      const candidate = JSON.parse(await readFile(paths.candidate, "utf8")) as {
        readonly attemptId: string;
      };
      assert.equal(candidate.attemptId, "attempt-000001");
      const state = await createStateStore({ projectRoot: clone }).readChange(
        "nueva-pagina-autoconsumo",
      );
      assert.equal(state.state, "generated");
    });
  } finally {
    await first?.dispose().catch(() => undefined);
    await second?.dispose().catch(() => undefined);
    await fixture?.dispose().catch(() => undefined);
    await rm(agentRoot, { recursive: true, force: true });
    process.chdir(previousCwd);
    if (previousCommandConfig === undefined)
      delete process.env.INGEST_COMMAND_AGENT_CONFIG;
    else process.env.INGEST_COMMAND_AGENT_CONFIG = previousCommandConfig;
  }
});

test("audit rejects mutated or missing sealed candidate evidence before any later effect", async () => {
  await withValidatedFixture(async ({ clone, controller }) => {
    const changeId = "nueva-pagina-autoconsumo";
    const candidate = JSON.parse(
      await readFile(
        join(clone, ".change-state", changeId, "candidate.json"),
        "utf8",
      ),
    ) as CandidateManifest;
    const preliminary = candidate.validations.find((validation) =>
      validation.evidence.startsWith("evidence/preliminary/"),
    );
    if (preliminary === undefined) {
      throw new Error("fixture candidate did not persist preliminary evidence");
    }
    const root = join(
      clone,
      ".change-state",
      changeId,
      "candidates",
      candidate.attemptId,
    );
    const preliminaryPath = join(root, ...preliminary.evidence.split("/"));
    const originalPreliminary = await readFile(preliminaryPath, "utf8");

    assert.equal((await controller.audit()).ok, true);
    await writeFile(preliminaryPath, `${originalPreliminary}\n`, "utf8");
    const mutated = await controller.audit();
    assert.equal(mutated.ok, false);
    assert.deepEqual(mutated.missing, [`change:${changeId}`]);

    await writeFile(preliminaryPath, originalPreliminary, "utf8");
    const buildPath = join(root, "evidence", "candidate-build.json");
    const originalBuild = await readFile(buildPath, "utf8");
    await rm(buildPath);
    const missing = await controller.audit();
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.missing, [`change:${changeId}`]);
    await writeFile(buildPath, originalBuild, "utf8");
  });
});

test("audit rejects a mutated sanitized dossier in a durable fixture", async () => {
  await withValidatedFixture(async ({ clone, fixture, controller }) => {
    const changeId = "nueva-pagina-autoconsumo";
    await approveFixtureGate2(clone, fixture, changeId);
    await writeFixtureDossier(clone, changeId);
    assert.equal((await controller.audit()).ok, true);

    const dossierCandidate = join(
      clone,
      ".artifacts",
      "ingestion-fixtures",
      changeId,
      "candidate.json",
    );
    const original = await readFile(dossierCandidate, "utf8");
    await writeFile(dossierCandidate, '{"tampered":true}\n', "utf8");
    const mutated = await controller.audit();
    assert.equal(mutated.ok, false);
    assert.deepEqual(mutated.missing, [`change:${changeId}`]);

    await writeFile(dossierCandidate, original, "utf8");
    await rm(dossierCandidate);
    const missing = await controller.audit();
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.missing, [`change:${changeId}`]);
  });
});

test("fixture E2E rejects changed evidence or artifact before Gate 2 and any publication", async () => {
  await withValidatedFixture(async ({ clone, controller }) => {
    const changeId = "nueva-pagina-autoconsumo";
    const candidate = JSON.parse(
      await readFile(
        join(clone, ".change-state", changeId, "candidate.json"),
        "utf8",
      ),
    ) as CandidateManifest;
    const root = join(
      clone,
      ".change-state",
      changeId,
      "candidates",
      candidate.attemptId,
    );
    const preliminary = candidate.validations.find((validation) =>
      validation.evidence.startsWith("evidence/preliminary/"),
    );
    if (preliminary === undefined) {
      throw new Error("fixture candidate did not persist preliminary evidence");
    }
    const evidencePath = join(root, ...preliminary.evidence.split("/"));
    const originalEvidence = await readFile(evidencePath, "utf8");

    await writeFile(evidencePath, `${originalEvidence}\n`, "utf8");
    await assert.rejects(
      () => controller.preview({ changeId, checkOnly: true }),
      /evidencia|hash|digest/i,
    );
    await writeFile(evidencePath, originalEvidence, "utf8");

    const artifactPath = join(
      clone,
      ".artifacts",
      "candidates",
      changeId,
      candidate.attemptId,
      "bundle",
      "dist",
      "index.html",
    );
    const originalArtifact = await readFile(artifactPath, "utf8");
    await writeFile(artifactPath, `${originalArtifact}tampered\n`, "utf8");
    await assert.rejects(
      () => controller.preview({ changeId, checkOnly: true }),
      /digest|artefacto|artifact/i,
    );
    await writeFile(artifactPath, originalArtifact, "utf8");

    const state = await createStateStore({ projectRoot: clone }).readChange(
      changeId,
    );
    assert.equal(state.state, "validated");
    await assert.rejects(
      () =>
        controller.publishLocal({
          changeId,
          operator: {} as never,
        }),
      /gate2_approved/i,
    );
    await assert.rejects(
      () =>
        readFile(
          join(clone, ".change-state", changeId, "approvals", "gate-2.json"),
          "utf8",
        ),
      { code: "ENOENT" },
    );
  });
});
