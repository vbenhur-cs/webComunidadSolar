import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
import {
  canonicalJson,
  sha256Canonical,
} from "../../src/ingest/canonical-json.ts";
import {
  openIngestionAuditController,
  openIngestionControllerForTest,
  type IngestionAudit,
} from "../../src/ingest/controller.ts";
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

function fixtureRecordFiles(
  changeId = fixtureRecordChangeId,
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
    validations: ["build"],
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
  const gate2 = {
    schemaVersion: 1,
    environment: "test",
    gate: 2,
    changeId,
    actor: "test-human",
    approvedAt: "2026-09-01T00:00:00.000Z",
    subjectSha256: fixtureRecordHash,
    baselineCommit: fixtureRecordCommit,
    candidateCommit: fixtureRecordCommit,
    artifactSha256: fixtureRecordArtifactHash,
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
    validations: [
      {
        id: "build",
        status: "passed",
        evidence: "evidence/build.json",
        evidenceSha256: fixtureRecordEvidenceHash,
      },
    ],
    failure: null,
  };
  const candidate = {
    schemaVersion: 1,
    changeId,
    attemptId: "attempt-000001",
    requestSha256: fixtureRecordHash,
    planSha256: fixtureRecordPlanHash,
    baselineCommit: fixtureRecordCommit,
    candidateCommit: fixtureRecordCommit,
    artifactSha256: fixtureRecordArtifactHash,
    approvalSubjectSha256: fixtureRecordHash,
    buildProfile: plan.publication,
    routes: ["/fixture-record"],
    files: ["src/pages/fixture-record.astro"],
    artifacts: [
      {
        path: "bundle/dist/index.html",
        sha256: fixtureRecordHash,
        bytes: 17,
      },
    ],
    validations: [
      { id: "build", status: "passed", evidence: "evidence/build.json" },
    ],
    preview: { command: "sealed verified candidate preview" },
    knownDifferences: [],
  };
  return new Map([
    ["request.json", `${canonicalJson(request)}\n`],
    ["plan.json", `${canonicalJson(plan)}\n`],
    ["approvals/gate-1.json", `${canonicalJson(gate1)}\n`],
    ["approvals/gate-2.json", `${canonicalJson(gate2)}\n`],
    ["attempts/attempt-000001.json", `${canonicalJson(attempt)}\n`],
    ["candidate.json", `${canonicalJson(candidate)}\n`],
  ]);
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

async function withFixtureAuditGit<T>(
  tags: Readonly<Record<string, string>>,
  operation: () => Promise<T>,
): Promise<T> {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError("El Git fixture de auditoría exige modo de pruebas");
  }
  const bin = await mkdtemp(join(tmpdir(), "ingestion-audit-git-"));
  const executable = join(bin, "git");
  const originalPath = process.env.PATH;
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
const tags = ${JSON.stringify(tags)};
const suffix = "^{commit}";
const requested = args.at(-1) ?? "";
const ref = requested.endsWith(suffix) ? requested.slice(0, -suffix.length) : requested;
const prefix = "refs/tags/ingestion-fixture/";
if (args.includes("for-each-ref")) {
  if (ref === "refs/tags/ingestion-fixture" || ref === prefix) {
    for (const id of Object.keys(tags).sort()) process.stdout.write(prefix + id + "\\n");
  } else {
    const id = ref.startsWith(prefix) ? ref.slice(prefix.length) : "";
    if (id !== "" && tags[id] !== undefined) process.stdout.write(ref + "\\n");
  }
  process.exit(0);
}
if (args.includes("rev-parse")) {
  const id = ref.startsWith(prefix) ? ref.slice(prefix.length) : "";
  if (id !== "" && tags[id] !== undefined) {
    process.stdout.write(tags[id] + "\\n");
    process.exit(0);
  }
  process.exit(1);
}
process.exit(64);
`;
  try {
    await writeFile(executable, source, { encoding: "utf8", mode: 0o700 });
    await chmod(executable, 0o700);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    return await operation();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(bin, { recursive: true, force: true });
  }
}

async function auditFixtureRecords(
  tags: Readonly<Record<string, string>>,
): Promise<IngestionAudit> {
  const controller = await openIngestionAuditController();
  try {
    return await withFixtureAuditGit(tags, () => controller.audit());
  } finally {
    await controller.dispose();
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
