import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256Canonical } from "../../src/ingest/canonical-json.ts";
import type { CandidateManifest, ChangePlan } from "../../src/ingest/domain.ts";
import { ingestPaths } from "../../src/ingest/paths.ts";
import {
  approveGate1,
  approveGate2,
  verifyApproval,
} from "../../src/ingest/approvals/service.ts";
import type { ApprovalPrompt } from "../../src/ingest/approvals/prompt.ts";

const hash = (character: string) => character.repeat(64);
const baselineCommit = "b".repeat(40);

function plan(overrides: Partial<ChangePlan> = {}): ChangePlan {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId: "nueva-pagina-autoconsumo",
    baselineCommit,
    requestSha256: hash("a"),
    selectedMode: "blocks" as const,
    targetPath: "/autoconsumo-compartido" as const,
    overwritesExistingRoute: false,
    files: [
      {
        path: "src/pages/autoconsumo-compartido.astro",
        operation: "create" as const,
      },
    ],
    components: [],
    islands: [],
    dependencies: [],
    validations: ["npm run check"],
    publication: {
      adapter: "local" as const,
      configSha256: hash("c"),
      environment: null,
      siteIndexable: false,
    },
    ...overrides,
  };
  const withoutHash = { ...unsigned } as typeof unsigned & {
    planSha256?: string;
  };
  delete withoutHash.planSha256;
  return {
    ...withoutHash,
    planSha256: sha256Canonical(withoutHash),
  } as ChangePlan;
}

function candidate(
  overrides: Partial<CandidateManifest> = {},
): CandidateManifest {
  return {
    schemaVersion: 1,
    changeId: "nueva-pagina-autoconsumo",
    attemptId: "attempt-000001",
    requestSha256: hash("a"),
    planSha256: plan().planSha256,
    baselineCommit,
    candidateCommit: "c".repeat(40),
    artifactSha256: hash("f"),
    buildProfile: plan().publication,
    routes: ["/autoconsumo-compartido"],
    files: ["src/pages/autoconsumo-compartido.astro"],
    validations: [
      { id: "typecheck", status: "passed", evidence: "evidence/typecheck.txt" },
    ],
    artifacts: [
      { path: "evidence/typecheck.txt", sha256: hash("f"), bytes: 12 },
    ],
    preview: { command: "npm run preview", url: "http://127.0.0.1:4321" },
    knownDifferences: [],
    ...overrides,
  };
}

function fakePrompt(options: {
  isTTY: boolean;
  answer?: string;
}): ApprovalPrompt {
  return {
    isTTY: options.isTTY,
    environment: "test",
    confirm: async () => options.answer ?? "",
  };
}

async function withStateRoot(
  run: (stateRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-approvals-"));
  try {
    await run(join(root, ".change-state"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("refuses approval without a human TTY", async () => {
  await withStateRoot(async (stateRoot) => {
    const input = { plan: plan(), actor: "test-human", stateRoot };

    await assert.rejects(
      approveGate1(input, fakePrompt({ isTTY: false })),
      /terminal interactivo/i,
    );

    const paths = await ingestPaths(input.plan.changeId, { stateRoot });
    await assert.rejects(readFile(join(paths.approvalsDir, "gate-1.json")), {
      code: "ENOENT",
    });
  });
});

test("requires the twelve-character subject hash confirmation", async () => {
  await withStateRoot(async (stateRoot) => {
    const input = { plan: plan(), actor: "test-human", stateRoot };

    await assert.rejects(
      approveGate1(input, fakePrompt({ isTTY: true, answer: "not-the-hash" })),
      /confirmaci[oó]n|hash/i,
    );
  });
});

test("invalidates Gate 1 after any plan change", async () => {
  await withStateRoot(async (stateRoot) => {
    const approvedPlan = plan();
    const gate1 = await approveGate1(
      { plan: approvedPlan, actor: "test-human", stateRoot },
      fakePrompt({
        isTTY: true,
        answer: approvedPlan.planSha256.slice(0, 12),
      }),
    );
    const changedPlan = plan({
      validations: ["npm run check", "npm run lint"],
    });

    assert.throws(
      () => verifyApproval(gate1, changedPlan, baselineCommit),
      /hash aprobado no coincide/i,
    );
  });
});

test("invalidates approval when main no longer equals its baseline", async () => {
  await withStateRoot(async (stateRoot) => {
    const approvedPlan = plan();
    const gate1 = await approveGate1(
      { plan: approvedPlan, actor: "test-human", stateRoot },
      fakePrompt({
        isTTY: true,
        answer: approvedPlan.planSha256.slice(0, 12),
      }),
    );

    assert.throws(
      () => verifyApproval(gate1, approvedPlan, "a".repeat(40)),
      /baseline/i,
    );
  });
});

test("Gate 2 binds canonical candidate, commit, and artifact digest", async () => {
  await withStateRoot(async (stateRoot) => {
    const approvedPlan = plan();
    const approvedCandidate = candidate({
      planSha256: approvedPlan.planSha256,
    });
    const gate2 = await approveGate2(
      {
        plan: approvedPlan,
        candidate: approvedCandidate,
        actor: "test-human",
        stateRoot,
      },
      fakePrompt({
        isTTY: true,
        answer: sha256Canonical(approvedCandidate).slice(0, 12),
      }),
    );

    assert.equal(gate2.subjectSha256, sha256Canonical(approvedCandidate));
    assert.equal(gate2.candidateCommit, approvedCandidate.candidateCommit);
    assert.equal(gate2.artifactSha256, approvedCandidate.artifactSha256);
    assert.doesNotThrow(() =>
      verifyApproval(gate2, approvedCandidate, baselineCommit),
    );

    const paths = await ingestPaths(approvedPlan.changeId, { stateRoot });
    assert.deepEqual(
      JSON.parse(
        await readFile(join(paths.approvalsDir, "gate-2.json"), "utf8"),
      ),
      gate2,
    );
  });
});

test("rejects anonymous and agent actors", async () => {
  await withStateRoot(async (stateRoot) => {
    for (const actor of ["", "agent", "codex", "fixture", "ab"]) {
      const approvedPlan = plan();
      await assert.rejects(
        approveGate1(
          { plan: approvedPlan, actor, stateRoot },
          fakePrompt({
            isTTY: true,
            answer: approvedPlan.planSha256.slice(0, 12),
          }),
        ),
        /actor|identidad/i,
      );
    }
  });
});
