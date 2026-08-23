import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { sha256Canonical } from "../../src/ingest/canonical-json.ts";
import type { CandidateManifest, ChangePlan } from "../../src/ingest/domain.ts";
import { ingestPaths } from "../../src/ingest/paths.ts";
import {
  approveGate1,
  approveGate2,
  verifyApproval,
} from "../../src/ingest/approvals/service.ts";
import {
  createFixtureApprovalPrompt,
  type FixtureApprovalPrompt,
} from "../../src/ingest/approvals/prompt.ts";

const hash = (character: string) => character.repeat(64);
const baselineCommit = "b".repeat(40);
const execFileAsync = promisify(execFile);

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

async function fixturePrompt(
  projectRoot: string,
  options: {
    isTTY: boolean;
    answer?: string;
  },
) {
  const previous = process.env.INGEST_TEST_MODE;
  process.env.INGEST_TEST_MODE = "true";
  try {
    return await createFixtureApprovalPrompt({
      projectRoot,
      isTTY: options.isTTY,
      answer: options.answer ?? "",
    });
  } finally {
    if (previous === undefined) delete process.env.INGEST_TEST_MODE;
    else process.env.INGEST_TEST_MODE = previous;
  }
}

async function withStateRoot(
  run: (context: { projectRoot: string; stateRoot: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-approvals-"));
  try {
    await execFileAsync("git", ["init", "--quiet", root]);
    await run({ projectRoot: root, stateRoot: join(root, ".change-state") });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("refuses approval without a human TTY", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot }) => {
    const input = { plan: plan(), actor: "test-human", stateRoot };

    await assert.rejects(
      approveGate1(input, await fixturePrompt(projectRoot, { isTTY: false })),
      /terminal interactivo/i,
    );

    const paths = await ingestPaths(input.plan.changeId, { stateRoot });
    await assert.rejects(readFile(join(paths.approvalsDir, "gate-1.json")), {
      code: "ENOENT",
    });
  });
});

test("requires the twelve-character subject hash confirmation", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot }) => {
    const input = { plan: plan(), actor: "test-human", stateRoot };

    await assert.rejects(
      approveGate1(
        input,
        await fixturePrompt(projectRoot, {
          isTTY: true,
          answer: "not-the-hash",
        }),
      ),
      /confirmaci[oó]n|hash/i,
    );
  });
});

test("invalidates Gate 1 after any plan change", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot }) => {
    const approvedPlan = plan();
    const gate1 = await approveGate1(
      { plan: approvedPlan, actor: "test-human", stateRoot },
      await fixturePrompt(projectRoot, {
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
  await withStateRoot(async ({ projectRoot, stateRoot }) => {
    const approvedPlan = plan();
    const gate1 = await approveGate1(
      { plan: approvedPlan, actor: "test-human", stateRoot },
      await fixturePrompt(projectRoot, {
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
  await withStateRoot(async ({ projectRoot, stateRoot }) => {
    const approvedPlan = plan();
    const approvedCandidate = candidate({
      planSha256: approvedPlan.planSha256,
    });
    await approveGate1(
      { plan: approvedPlan, actor: "test-human", stateRoot },
      await fixturePrompt(projectRoot, {
        isTTY: true,
        answer: approvedPlan.planSha256.slice(0, 12),
      }),
    );
    const gate2 = await approveGate2(
      {
        plan: approvedPlan,
        candidate: approvedCandidate,
        actor: "test-human",
        stateRoot,
        currentBaseline: baselineCommit,
      },
      await fixturePrompt(projectRoot, {
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
  await withStateRoot(async ({ projectRoot, stateRoot }) => {
    for (const actor of ["", "agent", "codex", "fixture", "ab"]) {
      const approvedPlan = plan();
      await assert.rejects(
        approveGate1(
          { plan: approvedPlan, actor, stateRoot },
          await fixturePrompt(projectRoot, {
            isTTY: true,
            answer: approvedPlan.planSha256.slice(0, 12),
          }),
        ),
        /actor|identidad/i,
      );
    }
  });
});

test("rejects structural prompts that claim production provenance", async () => {
  await withStateRoot(async ({ stateRoot }) => {
    const approvedPlan = plan();

    await assert.rejects(
      approveGate1({ plan: approvedPlan, actor: "test-human", stateRoot }, {
        isTTY: true,
        environment: "production",
        confirm: async () => approvedPlan.planSha256.slice(0, 12),
      } as unknown as FixtureApprovalPrompt),
      /prompt|fixture|producci[oó]n/i,
    );
  });
});

test("refuses to create fixture prompts outside explicit test mode", async () => {
  await withStateRoot(async ({ projectRoot }) => {
    await assert.rejects(
      createFixtureApprovalPrompt({
        projectRoot,
        isTTY: true,
        answer: "irrelevant",
      }),
      /INGEST_TEST_MODE|fixture/i,
    );
  });
});

test("refuses fixture prompts outside a temporary Git worktree", async () => {
  const previous = process.env.INGEST_TEST_MODE;
  process.env.INGEST_TEST_MODE = "true";
  try {
    await assert.rejects(
      createFixtureApprovalPrompt({
        projectRoot: process.cwd(),
        isTTY: true,
        answer: "irrelevant",
      }),
      /clon temporal|fixture/i,
    );
  } finally {
    if (previous === undefined) delete process.env.INGEST_TEST_MODE;
    else process.env.INGEST_TEST_MODE = previous;
  }
});

test("fixture prompts cannot write approval state outside their temporary clone", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot }) => {
    const foreignRoot = await mkdtemp(
      join(tmpdir(), "comunidadsolar-foreign-"),
    );
    try {
      const approvedPlan = plan();
      await assert.rejects(
        approveGate1(
          {
            plan: approvedPlan,
            actor: "test-human",
            stateRoot: join(foreignRoot, ".change-state"),
          },
          await fixturePrompt(projectRoot, {
            isTTY: true,
            answer: approvedPlan.planSha256.slice(0, 12),
          }),
        ),
        /fixture|estado|clon/i,
      );
      await assert.rejects(
        readFile(
          join(
            foreignRoot,
            ".change-state",
            "nueva-pagina-autoconsumo",
            "approvals",
            "gate-1.json",
          ),
        ),
        { code: "ENOENT" },
      );
      assert.equal(stateRoot, join(projectRoot, ".change-state"));
    } finally {
      await rm(foreignRoot, { force: true, recursive: true });
    }
  });
});

test("Gate 2 requires a persisted, valid Gate 1 approval", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot }) => {
    const approvedPlan = plan();
    const approvedCandidate = candidate({
      planSha256: approvedPlan.planSha256,
    });

    await assert.rejects(
      approveGate2(
        {
          plan: approvedPlan,
          candidate: approvedCandidate,
          actor: "test-human",
          stateRoot,
          currentBaseline: baselineCommit,
        },
        await fixturePrompt(projectRoot, {
          isTTY: true,
          answer: sha256Canonical(approvedCandidate).slice(0, 12),
        }),
      ),
      /Gate 1|aprobaci[oó]n/i,
    );
  });
});

test("Gate 2 rejects an advanced current baseline", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot }) => {
    const approvedPlan = plan();
    const approvedCandidate = candidate({
      planSha256: approvedPlan.planSha256,
    });
    await approveGate1(
      { plan: approvedPlan, actor: "test-human", stateRoot },
      await fixturePrompt(projectRoot, {
        isTTY: true,
        answer: approvedPlan.planSha256.slice(0, 12),
      }),
    );

    await assert.rejects(
      approveGate2(
        {
          plan: approvedPlan,
          candidate: approvedCandidate,
          actor: "test-human",
          stateRoot,
          currentBaseline: "a".repeat(40),
        },
        await fixturePrompt(projectRoot, {
          isTTY: true,
          answer: sha256Canonical(approvedCandidate).slice(0, 12),
        }),
      ),
      /baseline/i,
    );
  });
});

test("Gate 2 rejects candidates from a different request or build profile", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot }) => {
    const approvedPlan = plan();
    await approveGate1(
      { plan: approvedPlan, actor: "test-human", stateRoot },
      await fixturePrompt(projectRoot, {
        isTTY: true,
        answer: approvedPlan.planSha256.slice(0, 12),
      }),
    );

    for (const invalidCandidate of [
      candidate({
        planSha256: approvedPlan.planSha256,
        requestSha256: hash("d"),
      }),
      candidate({
        planSha256: approvedPlan.planSha256,
        buildProfile: { ...approvedPlan.publication, configSha256: hash("e") },
      }),
    ]) {
      await assert.rejects(
        approveGate2(
          {
            plan: approvedPlan,
            candidate: invalidCandidate,
            actor: "test-human",
            stateRoot,
            currentBaseline: baselineCommit,
          },
          await fixturePrompt(projectRoot, {
            isTTY: true,
            answer: sha256Canonical(invalidCandidate).slice(0, 12),
          }),
        ),
        /candidato|plan|request|perfil/i,
      );
    }
  });
});

test("verification rejects persisted non-human actor names", () => {
  const approvedPlan = plan();
  const validRecord = {
    schemaVersion: 1 as const,
    environment: "test" as const,
    gate: 1 as const,
    changeId: approvedPlan.changeId,
    actor: "test-human",
    approvedAt: "2026-08-23T10:00:00.000Z",
    subjectSha256: approvedPlan.planSha256,
    baselineCommit,
    candidateCommit: null,
    artifactSha256: null,
  };

  for (const actor of ["", "agent", "codex", "fixture", " test-human "]) {
    assert.throws(
      () =>
        verifyApproval({ ...validRecord, actor }, approvedPlan, baselineCommit),
      /actor|identidad/i,
    );
  }
});
