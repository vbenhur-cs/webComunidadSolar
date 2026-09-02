import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";

import {
  createFixtureApprovalRun,
  type FixtureApprovalRun,
} from "../../src/ingest/approvals/prompt.ts";
import {
  approveGate1,
  approveGate2,
} from "../../src/ingest/approvals/service.ts";
import {
  canonicalJson,
  sha256Canonical,
} from "../../src/ingest/canonical-json.ts";
import {
  candidateApprovalSubject,
  candidateDossierCommitment,
  candidateDossierPreimage,
  sanitizedCandidateProjection,
} from "../../src/ingest/dossier-integrity.ts";
import {
  createIngestionAuditTestSeal,
  openIngestionAuditController,
  openIngestionAuditControllerForTest,
  openIngestionControllerForTest,
  type IngestionAudit,
  type IngestionAuditTestTag,
} from "../../src/ingest/controller.ts";
import {
  candidateDossierCommitmentFromProjection,
  sanitizedDossierSha256,
} from "../../src/ingest/dossier-integrity.ts";
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
const fixtureSuiteRoot = process.cwd();
const fixtureSeedExcludedRoots = new Set([
  ".agent-quarantine",
  ".agent-worktrees",
  ".artifacts",
  ".astro",
  ".change-state",
  ".git",
  ".source-work",
  ".worktrees",
  ".wrangler",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
let fixtureSourcePromise: Promise<string> | undefined;
let fixtureSourceSession: string | undefined;

process.env.INGEST_TEST_MODE ??= "true";

function includeInFixtureSeed(path: string): boolean {
  const pathFromRoot = relative(fixtureSuiteRoot, path);
  if (pathFromRoot === "") return true;
  const [root] = pathFromRoot.split(/[\\/]/u);
  if (root === undefined || fixtureSeedExcludedRoots.has(root)) return false;
  if (
    root === ".env" ||
    (root.startsWith(".env.") && root !== ".env.example")
  ) {
    return false;
  }
  return !root.startsWith(".dev.vars");
}

async function fixtureSourceRepository(): Promise<string> {
  if (fixtureSourcePromise !== undefined) return fixtureSourcePromise;
  fixtureSourcePromise = (async () => {
    try {
      const topLevel = await execFileAsync(
        "git",
        ["-C", fixtureSuiteRoot, "rev-parse", "--show-toplevel"],
        { encoding: "utf8" },
      );
      if (resolve(topLevel.stdout.trim()) === resolve(fixtureSuiteRoot)) {
        return fixtureSuiteRoot;
      }
    } catch (error: unknown) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (!/not a git repository/iu.test(stderr)) throw error;
    }

    fixtureSourceSession = await mkdtemp(
      join(tmpdir(), "comunidadsolar-ingestion-e2e-seed-"),
    );
    const repository = join(fixtureSourceSession, "source");
    await cp(fixtureSuiteRoot, repository, {
      recursive: true,
      verbatimSymlinks: true,
      filter: includeInFixtureSeed,
    });
    await execFileAsync(
      "git",
      ["-C", repository, "init", "--quiet", "--initial-branch=main"],
      { encoding: "utf8" },
    );
    await execFileAsync("git", ["-C", repository, "add", "-A"], {
      encoding: "utf8",
    });
    await execFileAsync(
      "git",
      [
        "-C",
        repository,
        "-c",
        "user.name=Comunidad Solar Tests",
        "-c",
        "user.email=tests@invalid.example",
        "commit",
        "--quiet",
        "-m",
        "test: seed archived fixture repository",
      ],
      { encoding: "utf8" },
    );
    return repository;
  })();
  return fixtureSourcePromise;
}

after(async () => {
  if (fixtureSourceSession !== undefined) {
    await rm(fixtureSourceSession, { recursive: true, force: true });
  }
});

async function withTemporaryMainClone<T>(
  operation: (root: string) => Promise<T>,
): Promise<T> {
  const source = await fixtureSourceRepository();
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
    answer: candidateApprovalSubject(approvedCandidate).slice(0, 12),
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
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("the command fixture did not start in time");
}

async function createBlockingCommandAgent(
  root: string,
  recorder: string,
  release: string,
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
      `await appendFile(${JSON.stringify(recorder)}, "started\\n", "utf8");
const releasePath = ${JSON.stringify(release)};
const deadline = Date.now() + 30_000;
for (;;) {
  try {
    await readFile(releasePath, "utf8");
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (Date.now() >= deadline) throw new Error("race barrier was not released");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

let input = "";`,
    );
  const path = join(root, "blocking-command-agent.mjs");
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
  const destination = join(repositoryRoot, "changes", changeId);
  for (const file of dossier.files) {
    const target = join(destination, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, "utf8");
  }
}

const fixtureRecordChangeId = "fixture-request-blocks";
const fixtureRecordCommit = "a".repeat(40);
const fixtureRecordHash = "b".repeat(64);
const fixtureRecordPlanHash = "c".repeat(64);
const fixtureRecordArtifactHash = "d".repeat(64);
const fixtureRecordEvidenceHash = "e".repeat(64);

interface FixtureRecordValidation {
  readonly id: string;
  readonly evidenceSha256: string;
}

const fixtureRecordValidations: readonly FixtureRecordValidation[] = [
  { id: "build", evidenceSha256: fixtureRecordEvidenceHash },
];

function fixtureRecordCandidateManifest(
  changeId: string,
  validations: readonly FixtureRecordValidation[] = fixtureRecordValidations,
  includeEvidenceSha256 = true,
): CandidateManifest {
  return {
    schemaVersion: 1,
    changeId,
    attemptId: "attempt-000001",
    requestSha256: fixtureRecordHash,
    planSha256: fixtureRecordPlanHash,
    baselineCommit: fixtureRecordCommit,
    candidateCommit: fixtureRecordCommit,
    artifactSha256: fixtureRecordArtifactHash,
    buildProfile: {
      adapter: "local",
      configSha256: fixtureRecordHash,
      environment: null,
      siteIndexable: false,
    },
    routes: ["/fixture-record"],
    files: ["src/pages/fixture-record.astro"],
    artifacts: [
      {
        path: `.artifacts/candidates/${changeId}/attempt-000001/bundle/dist/index.html`,
        sha256: fixtureRecordHash,
        bytes: 17,
      },
    ],
    validations: validations.map((validation) => ({
      id: validation.id,
      status: "passed" as const,
      evidence: `evidence/candidate-${validation.id}.json#${validation.id}`,
      ...(includeEvidenceSha256
        ? { evidenceSha256: validation.evidenceSha256 }
        : {}),
    })),
    preview: {
      command: "fixture preview --check-only",
      url: "http://127.0.0.1:4321",
    },
    knownDifferences: [],
  };
}

function fixtureRecordFiles(
  changeId = fixtureRecordChangeId,
  validations: readonly FixtureRecordValidation[] = fixtureRecordValidations,
): ReadonlyMap<string, string> {
  const request = {
    schemaVersion: 1,
    changeId,
    inputKind: "request",
    targetPath: "/fixture-record",
    mode: "blocks",
    privacy: { private: false, area: null },
    inputSha256: fixtureRecordHash,
  };
  const plan = {
    schemaVersion: 1,
    changeId,
    baselineCommit: fixtureRecordCommit,
    requestSha256: fixtureRecordHash,
    selectedMode: "blocks",
    targetPath: "/fixture-record",
    overwritesExistingRoute: false,
    files: [{ path: "src/pages/fixture-record.astro", operation: "create" }],
    components: [],
    islands: [],
    dependencies: [],
    validations: validations.map((validation) => validation.id),
    publication: {
      adapter: "local",
      configSha256: fixtureRecordHash,
      environment: null,
      siteIndexable: false,
    },
    planSha256: fixtureRecordPlanHash,
  };
  const gate1 = {
    schemaVersion: 1,
    environment: "test",
    gate: 1,
    changeId,
    actor: "test-human",
    approvedAt: "2026-09-01T00:00:00.000Z",
    subjectSha256: fixtureRecordPlanHash,
    baselineCommit: fixtureRecordCommit,
    candidateCommit: null,
    artifactSha256: null,
  };
  const attempt = {
    schemaVersion: 1,
    changeId,
    attemptId: "attempt-000001",
    status: "validated",
    resumeState: null,
    adapter: "command",
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:01:00.000Z",
    requestSha256: fixtureRecordHash,
    planSha256: fixtureRecordPlanHash,
    baselineCommit: fixtureRecordCommit,
    generatedFiles: ["src/pages/fixture-record.astro"],
    logs: { stdout: null, stderr: null, finalMessage: null },
    validations: validations.map((validation) => ({
      id: validation.id,
      status: "passed" as const,
      evidence: `evidence/${validation.id}.json`,
      evidenceSha256: validation.evidenceSha256,
    })),
    failure: null,
  };
  const candidateManifest = fixtureRecordCandidateManifest(
    changeId,
    validations,
  );
  const preimage = candidateDossierPreimage(candidateManifest);
  const projection = sanitizedCandidateProjection(candidateManifest);
  const commitment = candidateDossierCommitment(candidateManifest);
  const candidate = { ...projection, ...commitment };
  const gate2 = {
    schemaVersion: 1,
    environment: "test",
    gate: 2,
    changeId,
    actor: "test-human",
    approvedAt: "2026-09-01T00:00:00.000Z",
    subjectSha256: commitment.approvalSubjectSha256,
    baselineCommit: fixtureRecordCommit,
    candidateCommit: fixtureRecordCommit,
    artifactSha256: fixtureRecordArtifactHash,
  };
  return new Map([
    ["request.json", `${canonicalJson(request)}\n`],
    ["plan.json", `${canonicalJson(plan)}\n`],
    ["approvals/gate-1.json", `${canonicalJson(gate1)}\n`],
    ["approvals/gate-2.json", `${canonicalJson(gate2)}\n`],
    ["attempts/attempt-000001.json", `${canonicalJson(attempt)}\n`],
    ["candidate.json", `${canonicalJson(candidate)}\n`],
    ["candidate-manifest.json", `${canonicalJson(preimage)}\n`],
  ]);
}

/** Rebuilds only test-seam facts so audit exercises the durable bindings. */
function resealFixtureCandidateDossier(files: Map<string, string>): void {
  const candidate = JSON.parse(files.get("candidate.json") ?? "") as Record<
    string,
    unknown
  >;
  const preimage = JSON.parse(
    files.get("candidate-manifest.json") ?? "",
  ) as Record<string, unknown>;
  const gate2 = JSON.parse(files.get("approvals/gate-2.json") ?? "") as Record<
    string,
    unknown
  >;
  const projection = { ...candidate };
  delete projection.approvalSubjectSha256;
  delete projection.sanitizedProjectionSha256;
  delete projection.sealedCandidateSha256;
  const commitment = candidateDossierCommitmentFromProjection(
    sha256Canonical(preimage),
    projection,
  );
  candidate.sealedCandidateSha256 = commitment.sealedCandidateSha256;
  candidate.sanitizedProjectionSha256 = commitment.sanitizedProjectionSha256;
  candidate.approvalSubjectSha256 = commitment.approvalSubjectSha256;
  gate2.subjectSha256 = commitment.approvalSubjectSha256;
  files.set("candidate.json", `${canonicalJson(candidate)}\n`);
  files.set("approvals/gate-2.json", `${canonicalJson(gate2)}\n`);
}

async function writeFixtureRecord(
  repositoryRoot: string,
  files = fixtureRecordFiles(),
  changeId = fixtureRecordChangeId,
): Promise<void> {
  for (const [path, contents] of files) {
    const target = join(
      repositoryRoot,
      "changes",
      changeId,
      ...path.split("/"),
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
}

function fixtureRecordAuditTag(
  changeId: string,
  candidateCommit: string,
): IngestionAuditTestTag {
  const files = fixtureRecordFiles(changeId);
  return fixtureRecordAuditTagForFiles(files, changeId, candidateCommit);
}

function fixtureRecordAuditTagForFiles(
  files: ReadonlyMap<string, string>,
  changeId: string,
  candidateCommit: string,
): IngestionAuditTestTag {
  const candidate = JSON.parse(files.get("candidate.json") ?? "") as {
    readonly sealedCandidateSha256: string;
    readonly sanitizedProjectionSha256: string;
    readonly approvalSubjectSha256: string;
  };
  return {
    changeId,
    candidateCommit,
    sealedCandidateSha256: candidate.sealedCandidateSha256,
    sanitizedProjectionSha256: candidate.sanitizedProjectionSha256,
    gate2SubjectSha256: candidate.approvalSubjectSha256,
    dossierSha256: sanitizedDossierSha256(
      [...files].map(([path, contents]) => ({ path, contents })),
    ),
  };
}

async function auditFixtureRecords(
  tags: Readonly<Record<string, string>>,
): Promise<IngestionAudit> {
  const seal = createIngestionAuditTestSeal(
    Object.entries(tags).map(([changeId, candidateCommit]) =>
      fixtureRecordAuditTag(changeId, candidateCommit),
    ),
  );
  return await auditFixtureSeal(seal);
}

async function auditFixtureSeal(
  seal: ReturnType<typeof createIngestionAuditTestSeal>,
): Promise<IngestionAudit> {
  const controller = await openIngestionAuditControllerForTest(seal);
  try {
    return await controller.audit();
  } finally {
    await controller.dispose();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
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

test("fixture record source keeps its only durable dossiers under trackable changes", async () => {
  const source = await readFile(
    join(process.cwd(), "tests/fixtures/ingestion/run-e2e.ts"),
    "utf8",
  );
  assert.match(source, /assertChangesUsable/u);
  assert.match(source, /changes["']/u);
  assert.match(source, /fixture-request-blocks/u);
  assert.match(source, /fixture-request-hybrid/u);
  assert.match(source, /fixture-page-freeform/u);
  assert.doesNotMatch(source, /assertArtifactsUsable/u);
});

test("fixture record preflight accepts only the three prior closed dossiers", async () => {
  const previousCwd = process.cwd();
  type Inspect = (root: string) => Promise<{
    readonly untracked: readonly string[];
  }>;
  const runner =
    (await import("../fixtures/ingestion/run-e2e.ts")) as unknown as {
      inspectFixtureRecordWorkspace?: Inspect;
    };
  const inspect = runner.inspectFixtureRecordWorkspace;
  assert.equal(typeof inspect, "function");
  if (inspect === undefined) return;
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const partial = join(
        clone,
        "changes",
        "fixture-request-blocks",
        "proof.json",
      );
      await mkdir(dirname(partial), { recursive: true });
      await writeFile(partial, "{}\n", "utf8");
      await assert.rejects(
        () => inspect(clone),
        /dossiers cerrados completos/i,
      );
      await rm(join(clone, "changes", "fixture-request-blocks"), {
        recursive: true,
        force: true,
      });

      const expected: string[] = [];
      for (const changeId of [
        "fixture-request-blocks",
        "fixture-request-hybrid",
        "fixture-page-freeform",
      ]) {
        const files = fixtureRecordFiles(changeId);
        await writeFixtureRecord(clone, files, changeId);
        expected.push(
          ...[...files.keys()].map((path) => `changes/${changeId}/${path}`),
        );
        assert.deepEqual(
          (await inspect(clone)).untracked,
          [...expected].sort(),
        );
      }

      const foreign = join(clone, "changes", "foreign-change", "proof.json");
      await mkdir(dirname(foreign), { recursive: true });
      await writeFile(foreign, "{}\n", "utf8");
      await assert.rejects(() => inspect(clone), /suciedad|dossiers/i);
      await rm(join(clone, "changes", "foreign-change"), {
        recursive: true,
        force: true,
      });

      const unrelated = join(clone, "unrelated-proof.json");
      await writeFile(unrelated, "{}\n", "utf8");
      await assert.rejects(() => inspect(clone), /suciedad|preparados/i);
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("audit rejects a fixture tag without its durable dossier", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const audit = await auditFixtureRecords({
        [fixtureRecordChangeId]: fixtureRecordCommit,
      });
      assert.equal(audit.ok, false);
      assert.deepEqual(audit.missing, [`fixture:${fixtureRecordChangeId}`]);
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("audit rejects a durable fixture dossier without its tag", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      await writeFixtureRecord(clone);
      const audit = await auditFixtureRecords({});
      assert.equal(audit.ok, false);
      assert.deepEqual(audit.missing, [`fixture:${fixtureRecordChangeId}`]);
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("audit rejects an altered durable fixture dossier", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      await writeFixtureRecord(clone);
      const tags = { [fixtureRecordChangeId]: fixtureRecordCommit };
      const verified = await auditFixtureRecords(tags);
      assert.equal(verified.ok, true, JSON.stringify(verified));
      const candidatePath = join(
        clone,
        "changes",
        fixtureRecordChangeId,
        "candidate.json",
      );
      const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as {
        artifactSha256: string;
      };
      candidate.artifactSha256 = "f".repeat(64);
      await writeFile(candidatePath, `${canonicalJson(candidate)}\n`, "utf8");
      const audit = await auditFixtureRecords(tags);
      assert.equal(audit.ok, false);
      assert.deepEqual(audit.missing, [`fixture:${fixtureRecordChangeId}`]);
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("audit binds each attempt evidence digest to the sealed candidate preimage", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const files = new Map(fixtureRecordFiles());
      const attempt = JSON.parse(
        files.get("attempts/attempt-000001.json") ?? "",
      ) as { validations: Array<Record<string, unknown>> };
      const validation = attempt.validations[0];
      if (validation === undefined) {
        throw new TypeError("fixture attempt has no validation");
      }
      validation.evidenceSha256 = "f".repeat(64);
      files.set("attempts/attempt-000001.json", `${canonicalJson(attempt)}\n`);
      await writeFixtureRecord(clone, files);

      const audit = await auditFixtureSeal(
        createIngestionAuditTestSeal([
          fixtureRecordAuditTagForFiles(
            files,
            fixtureRecordChangeId,
            fixtureRecordCommit,
          ),
        ]),
      );
      assert.equal(audit.ok, false);
      assert.deepEqual(audit.missing, [`fixture:${fixtureRecordChangeId}`]);
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("audit binds each durable candidate evidence digest to its preimage and attempt", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const files = new Map(fixtureRecordFiles());
      const candidate = JSON.parse(files.get("candidate.json") ?? "") as {
        validations: Array<Record<string, unknown>>;
      };
      const validation = candidate.validations[0];
      if (validation === undefined) {
        throw new TypeError("fixture candidate has no validation");
      }
      validation.evidenceSha256 = fixtureRecordEvidenceHash;
      files.set("candidate.json", `${canonicalJson(candidate)}\n`);
      resealFixtureCandidateDossier(files);
      await writeFixtureRecord(clone, files);

      const verified = await auditFixtureSeal(
        createIngestionAuditTestSeal([
          fixtureRecordAuditTagForFiles(
            files,
            fixtureRecordChangeId,
            fixtureRecordCommit,
          ),
        ]),
      );
      assert.equal(verified.ok, true, JSON.stringify(verified));

      validation.evidenceSha256 = "f".repeat(64);
      files.set("candidate.json", `${canonicalJson(candidate)}\n`);
      resealFixtureCandidateDossier(files);
      await writeFixtureRecord(clone, files);
      const mismatched = await auditFixtureSeal(
        createIngestionAuditTestSeal([
          fixtureRecordAuditTagForFiles(
            files,
            fixtureRecordChangeId,
            fixtureRecordCommit,
          ),
        ]),
      );
      assert.equal(mismatched.ok, false);
      assert.deepEqual(mismatched.missing, [
        `fixture:${fixtureRecordChangeId}`,
      ]);
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("audit rejects reordered, missing, or extra attempt validation identities", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const validations: readonly FixtureRecordValidation[] = [
        { id: "build", evidenceSha256: fixtureRecordEvidenceHash },
        { id: "checks", evidenceSha256: "d".repeat(64) },
      ];
      const mutations: ReadonlyArray<{
        readonly name: string;
        readonly mutate: (validations: Array<Record<string, unknown>>) => void;
      }> = [
        {
          name: "reordered",
          mutate(attemptValidations) {
            attemptValidations.reverse();
          },
        },
        {
          name: "missing",
          mutate(attemptValidations) {
            attemptValidations.splice(0, 1);
          },
        },
        {
          name: "extra",
          mutate(attemptValidations) {
            attemptValidations.push({
              id: "extra",
              status: "passed",
              evidence: "evidence/extra.json",
              evidenceSha256: "c".repeat(64),
            });
          },
        },
      ];

      for (const { name, mutate } of mutations) {
        const files = new Map(
          fixtureRecordFiles(fixtureRecordChangeId, validations),
        );
        const attempt = JSON.parse(
          files.get("attempts/attempt-000001.json") ?? "",
        ) as { validations: Array<Record<string, unknown>> };
        mutate(attempt.validations);
        files.set(
          "attempts/attempt-000001.json",
          `${canonicalJson(attempt)}\n`,
        );
        await writeFixtureRecord(clone, files);

        const audit = await auditFixtureSeal(
          createIngestionAuditTestSeal([
            fixtureRecordAuditTagForFiles(
              files,
              fixtureRecordChangeId,
              fixtureRecordCommit,
            ),
          ]),
        );
        assert.equal(audit.ok, false, name);
        assert.deepEqual(
          audit.missing,
          [`fixture:${fixtureRecordChangeId}`],
          name,
        );
      }
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("audit rejects coherent failed or digestless durable validation facts", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const mutations: ReadonlyArray<{
        readonly name: string;
        readonly mutate: (files: Map<string, string>) => void;
      }> = [
        {
          name: "failed",
          mutate(files) {
            const candidate = JSON.parse(files.get("candidate.json") ?? "") as {
              validations: Array<Record<string, unknown>>;
            };
            const preimage = JSON.parse(
              files.get("candidate-manifest.json") ?? "",
            ) as { validations: Array<Record<string, unknown>> };
            const attempt = JSON.parse(
              files.get("attempts/attempt-000001.json") ?? "",
            ) as { validations: Array<Record<string, unknown>> };
            const [candidateValidation, preimageValidation, attemptValidation] =
              [
                candidate.validations[0],
                preimage.validations[0],
                attempt.validations[0],
              ];
            if (
              candidateValidation === undefined ||
              preimageValidation === undefined ||
              attemptValidation === undefined
            ) {
              throw new TypeError("fixture dossier lost its validation");
            }
            candidateValidation.status = "failed";
            preimageValidation.status = "failed";
            attemptValidation.status = "failed";
            files.set("candidate.json", `${canonicalJson(candidate)}\n`);
            files.set(
              "candidate-manifest.json",
              `${canonicalJson(preimage)}\n`,
            );
            files.set(
              "attempts/attempt-000001.json",
              `${canonicalJson(attempt)}\n`,
            );
          },
        },
        {
          name: "missing-preimage-digest",
          mutate(files) {
            const preimage = JSON.parse(
              files.get("candidate-manifest.json") ?? "",
            ) as { validations: Array<Record<string, unknown>> };
            const validation = preimage.validations[0];
            if (validation === undefined) {
              throw new TypeError("fixture preimage has no validation");
            }
            validation.evidenceSha256 = null;
            files.set(
              "candidate-manifest.json",
              `${canonicalJson(preimage)}\n`,
            );
          },
        },
      ];

      for (const { name, mutate } of mutations) {
        const files = new Map(fixtureRecordFiles());
        mutate(files);
        resealFixtureCandidateDossier(files);
        await writeFixtureRecord(clone, files);
        const audit = await auditFixtureSeal(
          createIngestionAuditTestSeal([
            fixtureRecordAuditTagForFiles(
              files,
              fixtureRecordChangeId,
              fixtureRecordCommit,
            ),
          ]),
        );
        assert.equal(audit.ok, false, name);
        assert.deepEqual(
          audit.missing,
          [`fixture:${fixtureRecordChangeId}`],
          name,
        );
      }
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("a legacy Gate 2 cannot authorize a durable dossier without sealed evidence", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const files = new Map(fixtureRecordFiles());
      const legacyCandidate = fixtureRecordCandidateManifest(
        fixtureRecordChangeId,
        fixtureRecordValidations,
        false,
      );
      const preimage = JSON.parse(
        files.get("candidate-manifest.json") ?? "",
      ) as { validations: Array<Record<string, unknown>> };
      const preimageValidation = preimage.validations[0];
      if (preimageValidation === undefined) {
        throw new TypeError("fixture preimage has no validation");
      }
      preimageValidation.evidenceSha256 = null;

      const candidate = JSON.parse(files.get("candidate.json") ?? "") as Record<
        string,
        unknown
      >;
      const gate2 = JSON.parse(
        files.get("approvals/gate-2.json") ?? "",
      ) as Record<string, unknown>;
      const legacySubject = candidateApprovalSubject(legacyCandidate);
      candidate.sealedCandidateSha256 = sha256Canonical(preimage);
      candidate.sanitizedProjectionSha256 = sha256Canonical(
        sanitizedCandidateProjection(legacyCandidate),
      );
      candidate.approvalSubjectSha256 = legacySubject;
      gate2.subjectSha256 = legacySubject;
      files.set("candidate.json", `${canonicalJson(candidate)}\n`);
      files.set("candidate-manifest.json", `${canonicalJson(preimage)}\n`);
      files.set("approvals/gate-2.json", `${canonicalJson(gate2)}\n`);
      await writeFixtureRecord(clone, files);

      const audit = await auditFixtureSeal(
        createIngestionAuditTestSeal([
          fixtureRecordAuditTagForFiles(
            files,
            fixtureRecordChangeId,
            fixtureRecordCommit,
          ),
        ]),
      );
      assert.equal(audit.ok, false);
      assert.deepEqual(audit.missing, [`fixture:${fixtureRecordChangeId}`]);
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("audit rejects every altered canonical candidate projection even with coherent dossier facts", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      await writeFixtureRecord(clone);
      const tags = { [fixtureRecordChangeId]: fixtureRecordCommit };
      assert.equal((await auditFixtureRecords(tags)).ok, true);
      const candidatePath = join(
        clone,
        "changes",
        fixtureRecordChangeId,
        "candidate.json",
      );
      const attemptPath = join(
        clone,
        "changes",
        fixtureRecordChangeId,
        "attempts",
        "attempt-000001.json",
      );
      const originalCandidate = await readFile(candidatePath, "utf8");
      const originalAttempt = await readFile(attemptPath, "utf8");

      const mutations: ReadonlyArray<{
        readonly name: string;
        readonly mutate: (
          candidate: Record<string, unknown>,
          attempt: Record<string, unknown>,
        ) => void;
      }> = [
        {
          name: "routes",
          mutate(candidate) {
            candidate.routes = ["/fixture-record", "/fixture-record-alt"];
          },
        },
        {
          name: "files",
          mutate(candidate, attempt) {
            candidate.files = [
              "src/pages/fixture-record.astro",
              "src/pages/fixture-record-alt.astro",
            ];
            attempt.generatedFiles = [
              "src/pages/fixture-record.astro",
              "src/pages/fixture-record-alt.astro",
            ];
          },
        },
        {
          name: "artifacts",
          mutate(candidate) {
            candidate.artifacts = [
              {
                path: "bundle/dist/index.html",
                sha256: fixtureRecordHash,
                bytes: 17,
              },
              {
                path: "bundle/dist/alternate.html",
                sha256: "f".repeat(64),
                bytes: 23,
              },
            ];
          },
        },
        {
          name: "validations",
          mutate(candidate, attempt) {
            candidate.validations = [
              {
                id: "build",
                status: "passed",
                evidence: "evidence/build.json",
              },
              {
                id: "checks",
                status: "passed",
                evidence: "evidence/checks.json",
              },
            ];
            attempt.validations = [
              {
                id: "build",
                status: "passed",
                evidence: "evidence/build.json",
                evidenceSha256: fixtureRecordEvidenceHash,
              },
              {
                id: "checks",
                status: "passed",
                evidence: "evidence/checks.json",
                evidenceSha256: "f".repeat(64),
              },
            ];
          },
        },
      ];

      for (const { name, mutate } of mutations) {
        const candidate = JSON.parse(originalCandidate) as Record<
          string,
          unknown
        >;
        const attempt = JSON.parse(originalAttempt) as Record<string, unknown>;
        mutate(candidate, attempt);
        await Promise.all([
          writeFile(candidatePath, `${canonicalJson(candidate)}\n`, "utf8"),
          writeFile(attemptPath, `${canonicalJson(attempt)}\n`, "utf8"),
        ]);
        const audit = await auditFixtureRecords(tags);
        assert.equal(audit.ok, false, name);
        assert.deepEqual(
          audit.missing,
          [`fixture:${fixtureRecordChangeId}`],
          name,
        );
        await Promise.all([
          writeFile(candidatePath, originalCandidate, "utf8"),
          writeFile(attemptPath, originalAttempt, "utf8"),
        ]);
      }
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("audit rejects a candidate and Gate 2 rewritten together after durable sealing", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      await writeFixtureRecord(clone);
      const tags = { [fixtureRecordChangeId]: fixtureRecordCommit };
      assert.equal((await auditFixtureRecords(tags)).ok, true);
      const candidatePath = join(
        clone,
        "changes",
        fixtureRecordChangeId,
        "candidate.json",
      );
      const gate2Path = join(
        clone,
        "changes",
        fixtureRecordChangeId,
        "approvals",
        "gate-2.json",
      );
      const candidate = JSON.parse(
        await readFile(candidatePath, "utf8"),
      ) as Record<string, unknown>;
      candidate.routes = ["/fixture-record", "/rewritten-with-gate2"];
      const sealedCandidateSha256 = candidate.sealedCandidateSha256;
      if (typeof sealedCandidateSha256 !== "string") {
        throw new TypeError("the fixture candidate lost its sealed digest");
      }
      const projection = { ...candidate };
      delete projection.approvalSubjectSha256;
      delete projection.sanitizedProjectionSha256;
      delete projection.sealedCandidateSha256;
      const commitment = candidateDossierCommitmentFromProjection(
        sealedCandidateSha256,
        projection,
      );
      candidate.sanitizedProjectionSha256 =
        commitment.sanitizedProjectionSha256;
      candidate.approvalSubjectSha256 = commitment.approvalSubjectSha256;
      const gate2 = JSON.parse(await readFile(gate2Path, "utf8")) as Record<
        string,
        unknown
      >;
      gate2.subjectSha256 = commitment.approvalSubjectSha256;
      await Promise.all([
        writeFile(candidatePath, `${canonicalJson(candidate)}\n`, "utf8"),
        writeFile(gate2Path, `${canonicalJson(gate2)}\n`, "utf8"),
      ]);
      const audit = await auditFixtureRecords(tags);
      assert.equal(audit.ok, false);
      assert.deepEqual(audit.missing, [`fixture:${fixtureRecordChangeId}`]);
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("audit rejects a coherent arbitrary sealed digest without a matching durable candidate preimage", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const files = new Map(fixtureRecordFiles());
      const candidate = JSON.parse(files.get("candidate.json") ?? "") as Record<
        string,
        unknown
      >;
      const gate2 = JSON.parse(
        files.get("approvals/gate-2.json") ?? "",
      ) as Record<string, unknown>;
      const projection = { ...candidate };
      delete projection.approvalSubjectSha256;
      delete projection.sanitizedProjectionSha256;
      delete projection.sealedCandidateSha256;
      const commitment = candidateDossierCommitmentFromProjection(
        "f".repeat(64),
        projection,
      );
      candidate.sealedCandidateSha256 = commitment.sealedCandidateSha256;
      candidate.sanitizedProjectionSha256 =
        commitment.sanitizedProjectionSha256;
      candidate.approvalSubjectSha256 = commitment.approvalSubjectSha256;
      gate2.subjectSha256 = commitment.approvalSubjectSha256;
      files.set("candidate.json", `${canonicalJson(candidate)}\n`);
      files.set("approvals/gate-2.json", `${canonicalJson(gate2)}\n`);
      await writeFixtureRecord(clone, files);

      const audit = await auditFixtureSeal(
        createIngestionAuditTestSeal([
          {
            ...fixtureRecordAuditTag(
              fixtureRecordChangeId,
              fixtureRecordCommit,
            ),
            sealedCandidateSha256: commitment.sealedCandidateSha256,
            sanitizedProjectionSha256: commitment.sanitizedProjectionSha256,
            gate2SubjectSha256: commitment.approvalSubjectSha256,
            dossierSha256: sanitizedDossierSha256(
              [...files].map(([path, contents]) => ({ path, contents })),
            ),
          },
        ]),
      );

      assert.equal(audit.ok, false);
      assert.deepEqual(audit.missing, [`fixture:${fixtureRecordChangeId}`]);
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("audit rejects altered, missing, or schema-invalid durable candidate preimages", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const mutations: ReadonlyArray<{
        readonly name: string;
        readonly mutate: (files: Map<string, string>) => void;
      }> = [
        {
          name: "altered",
          mutate(files) {
            const preimage = JSON.parse(
              files.get("candidate-manifest.json") ?? "",
            ) as Record<string, unknown>;
            const preview = preimage.preview as Record<string, unknown>;
            preview.commandSha256 = "f".repeat(64);
            files.set(
              "candidate-manifest.json",
              `${canonicalJson(preimage)}\n`,
            );
          },
        },
        {
          name: "missing",
          mutate(files) {
            files.delete("candidate-manifest.json");
          },
        },
        {
          name: "schema-extra",
          mutate(files) {
            const preimage = JSON.parse(
              files.get("candidate-manifest.json") ?? "",
            ) as Record<string, unknown>;
            preimage.unexpected = true;
            files.set(
              "candidate-manifest.json",
              `${canonicalJson(preimage)}\n`,
            );
          },
        },
        {
          name: "invalid",
          mutate(files) {
            files.set("candidate-manifest.json", "{}\n");
          },
        },
      ];

      for (const { name, mutate } of mutations) {
        await rm(join(clone, "changes", fixtureRecordChangeId), {
          recursive: true,
          force: true,
        });
        const files = new Map(fixtureRecordFiles());
        mutate(files);
        await writeFixtureRecord(clone, files);
        const seal = createIngestionAuditTestSeal([
          fixtureRecordAuditTagForFiles(
            files,
            fixtureRecordChangeId,
            fixtureRecordCommit,
          ),
        ]);
        const audit = await auditFixtureSeal(seal);
        assert.equal(audit.ok, false, name);
        assert.deepEqual(
          audit.missing,
          [`fixture:${fixtureRecordChangeId}`],
          name,
        );
      }
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("production audit does not execute a Git binary injected through PATH", async () => {
  const previousCwd = process.cwd();
  const originalPath = process.env.PATH;
  const bin = await mkdtemp(join(tmpdir(), "ingestion-audit-path-injection-"));
  const executable = join(bin, "git");
  const marker = join(bin, "executed");
  let controller:
    Awaited<ReturnType<typeof openIngestionAuditController>> | undefined;
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      controller = await openIngestionAuditController();
      await writeFile(
        executable,
        `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
        { encoding: "utf8", mode: 0o700 },
      );
      await chmod(executable, 0o700);
      process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
      const audit = await controller.audit();
      assert.equal(audit.ok, true, JSON.stringify(audit));
      assert.equal(await pathExists(marker), false);
    });
  } finally {
    await controller?.dispose().catch(() => undefined);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    process.chdir(previousCwd);
    await rm(bin, { recursive: true, force: true });
  }
});

test("audit rejects a durable fixture Gate binding that no longer seals its candidate", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      await writeFixtureRecord(clone);
      const tags = { [fixtureRecordChangeId]: fixtureRecordCommit };
      assert.equal((await auditFixtureRecords(tags)).ok, true);
      const gate2Path = join(
        clone,
        "changes",
        fixtureRecordChangeId,
        "approvals",
        "gate-2.json",
      );
      const gate2 = JSON.parse(await readFile(gate2Path, "utf8")) as {
        subjectSha256: string;
      };
      gate2.subjectSha256 = "f".repeat(64);
      await writeFile(gate2Path, `${canonicalJson(gate2)}\n`, "utf8");
      const audit = await auditFixtureRecords(tags);
      assert.equal(audit.ok, false);
      assert.deepEqual(audit.missing, [`fixture:${fixtureRecordChangeId}`]);
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("audit rejects a fixture tag bound to another candidate commit", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      await writeFixtureRecord(clone);
      const audit = await auditFixtureRecords({
        [fixtureRecordChangeId]: "f".repeat(40),
      });
      assert.equal(audit.ok, false);
      assert.deepEqual(audit.missing, [`fixture:${fixtureRecordChangeId}`]);
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("audit rejects an altered durable tag seal", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      await writeFixtureRecord(clone);
      const tag = fixtureRecordAuditTag(
        fixtureRecordChangeId,
        fixtureRecordCommit,
      );
      const audit = await auditFixtureSeal(
        createIngestionAuditTestSeal([
          { ...tag, dossierSha256: "f".repeat(64) },
        ]),
      );
      assert.equal(audit.ok, false);
      assert.deepEqual(audit.missing, [`fixture:${fixtureRecordChangeId}`]);
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("production audit cannot consume test-only tag seals", async () => {
  const previousCwd = process.cwd();
  let production:
    Awaited<ReturnType<typeof openIngestionAuditController>> | undefined;
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const seal = createIngestionAuditTestSeal([
        fixtureRecordAuditTag(fixtureRecordChangeId, fixtureRecordCommit),
      ]);
      assert.equal((await auditFixtureSeal(seal)).ok, false);
      production = await openIngestionAuditController();
      const audit = await production.audit();
      assert.equal(audit.ok, true, JSON.stringify(audit));
    });
  } finally {
    await production?.dispose().catch(() => undefined);
    process.chdir(previousCwd);
  }
});

test("audit test-only seals reject raw values and require test mode", async () => {
  await assert.rejects(
    () =>
      openIngestionAuditControllerForTest(
        {} as ReturnType<typeof createIngestionAuditTestSeal>,
      ),
    /sello/i,
  );
  const previousTestMode = process.env.INGEST_TEST_MODE;
  delete process.env.INGEST_TEST_MODE;
  try {
    assert.throws(() => createIngestionAuditTestSeal([]), /modo de pruebas/i);
  } finally {
    if (previousTestMode === undefined) delete process.env.INGEST_TEST_MODE;
    else process.env.INGEST_TEST_MODE = previousTestMode;
  }
});

test("audit rejects a symlinked durable fixture dossier", async () => {
  const previousCwd = process.cwd();
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const changes = join(clone, "changes");
      const outside = join(clone, "fixture-outside");
      await mkdir(changes, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(changes, fixtureRecordChangeId));
      const audit = await auditFixtureRecords({
        [fixtureRecordChangeId]: fixtureRecordCommit,
      });
      assert.equal(audit.ok, false);
      assert.deepEqual(audit.missing, [`fixture:${fixtureRecordChangeId}`]);
    });
  } finally {
    process.chdir(previousCwd);
  }
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
  const release = join(agentRoot, "release");
  let first:
    Awaited<ReturnType<typeof openIngestionControllerForTest>> | undefined;
  let second:
    Awaited<ReturnType<typeof openIngestionControllerForTest>> | undefined;
  let fixture: FixtureApprovalRun | undefined;
  let firstGeneration: Promise<unknown> | undefined;
  let secondGeneration: Promise<unknown> | undefined;
  process.env.INGEST_TEST_MODE = "true";
  try {
    const agent = await createBlockingCommandAgent(
      agentRoot,
      recorder,
      release,
    );
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
      firstGeneration = first.generate({
        changeId: "nueva-pagina-autoconsumo",
        adapter: "command",
      });
      void firstGeneration.catch(() => undefined);
      await waitForRecordedStarts(recorder, 1);
      secondGeneration = second.generate({
        changeId: "nueva-pagina-autoconsumo",
        adapter: "command",
      });
      void secondGeneration.catch(() => undefined);
      await writeFile(release, "release\n", "utf8");
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
    await writeFile(release, "release\n", "utf8").catch(() => undefined);
    await Promise.allSettled(
      [firstGeneration, secondGeneration].filter(
        (operation): operation is Promise<unknown> => operation !== undefined,
      ),
    );
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

test("conflicting receives leave raw intake only for the request that won the change lock", async () => {
  const previousCwd = process.cwd();
  const previousTestMode = process.env.INGEST_TEST_MODE;
  let first:
    Awaited<ReturnType<typeof openIngestionControllerForTest>> | undefined;
  let second:
    Awaited<ReturnType<typeof openIngestionControllerForTest>> | undefined;
  let receives: Promise<unknown>[] = [];
  process.env.INGEST_TEST_MODE = "true";
  try {
    await withTemporaryMainClone(async (clone) => {
      process.chdir(clone);
      const original = await readFile(
        join(clone, "tests/fixtures/ingestion/detailed-request/request.yaml"),
        "utf8",
      );
      const firstSource = join(clone, "conflicting-receive-first.yaml");
      const secondSource = join(clone, "conflicting-receive-second.yaml");
      await writeFile(firstSource, original, "utf8");
      await writeFile(
        secondSource,
        original.replace(
          "Explicar el autoconsumo compartido",
          "Explicar el autoconsumo compartido alternativo",
        ),
        "utf8",
      );
      first = await openIngestionControllerForTest({});
      second = await openIngestionControllerForTest({});
      const firstController = first;
      const secondController = second;
      receives = Array.from({ length: 16 }, (_, index) =>
        (index % 2 === 0 ? firstController : secondController).receiveRequest({
          kind: "request",
          source: index % 2 === 0 ? firstSource : secondSource,
        }),
      );
      const outcomes = await Promise.allSettled(receives);
      assert.equal(
        outcomes.filter((outcome) => outcome.status === "fulfilled").length,
        1,
      );
      const changeId = "nueva-pagina-autoconsumo";
      const persisted = JSON.parse(
        await readFile(
          join(clone, ".change-state", changeId, "request.json"),
          "utf8",
        ),
      ) as { readonly inputSha256: string };
      assert.deepEqual(
        await readdir(join(clone, ".artifacts", "intake", changeId)),
        [persisted.inputSha256],
        "the losing intake must never persist outside the winning journal",
      );
    });
  } finally {
    await Promise.allSettled(receives);
    await first?.dispose().catch(() => undefined);
    await second?.dispose().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousTestMode === undefined) delete process.env.INGEST_TEST_MODE;
    else process.env.INGEST_TEST_MODE = previousTestMode;
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

    const dossierCandidate = join(clone, "changes", changeId, "candidate.json");
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
