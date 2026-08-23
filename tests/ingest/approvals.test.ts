import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
const defaultBaselineCommit = "b".repeat(40);
const execFileAsync = promisify(execFile);

function plan(overrides: Partial<ChangePlan> = {}): ChangePlan {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId: "nueva-pagina-autoconsumo",
    baselineCommit: defaultBaselineCommit,
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
    baselineCommit: defaultBaselineCommit,
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

async function withFixtureMode(run: () => Promise<void>): Promise<void> {
  const previous = process.env.INGEST_TEST_MODE;
  process.env.INGEST_TEST_MODE = "true";
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.INGEST_TEST_MODE;
    else process.env.INGEST_TEST_MODE = previous;
  }
}

async function withStateRoot(
  run: (context: {
    projectRoot: string;
    stateRoot: string;
    mainCommit: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-approvals-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  try {
    await execFileAsync("git", [
      "init",
      "--bare",
      "--quiet",
      "--initial-branch=main",
      origin,
    ]);
    await execFileAsync("git", [
      "init",
      "--quiet",
      "--initial-branch=main",
      seed,
    ]);
    await execFileAsync("git", [
      "-C",
      seed,
      "config",
      "user.email",
      "fixture@example.test",
    ]);
    await execFileAsync("git", [
      "-C",
      seed,
      "config",
      "user.name",
      "Fixture Human",
    ]);
    await writeFile(join(seed, "README.md"), "fixture clone\n", "utf8");
    await execFileAsync("git", ["-C", seed, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      seed,
      "commit",
      "--quiet",
      "-m",
      "fixture baseline",
    ]);
    await execFileAsync("git", ["-C", seed, "remote", "add", "origin", origin]);
    await execFileAsync("git", [
      "-C",
      seed,
      "push",
      "--quiet",
      "origin",
      "main",
    ]);
    await execFileAsync("git", [
      "clone",
      "--quiet",
      "--branch",
      "main",
      origin,
      clone,
    ]);
    const { stdout } = await execFileAsync("git", [
      "-C",
      clone,
      "rev-parse",
      "HEAD",
    ]);
    await run({
      projectRoot: clone,
      stateRoot: join(clone, ".change-state"),
      mainCommit: stdout.trim(),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function fixturePlan(
  mainCommit: string,
  overrides: Partial<ChangePlan> = {},
): ChangePlan {
  return plan({ baselineCommit: mainCommit, ...overrides });
}

function fixtureCandidate(
  mainCommit: string,
  approvedPlan: ChangePlan,
  overrides: Partial<CandidateManifest> = {},
): CandidateManifest {
  return candidate({
    baselineCommit: mainCommit,
    planSha256: approvedPlan.planSha256,
    ...overrides,
  });
}

test("refuses approval without a human TTY", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const input = {
      plan: fixturePlan(mainCommit),
      actor: "test-human",
      stateRoot,
      repositoryRoot: projectRoot,
    };

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
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const input = {
      plan: fixturePlan(mainCommit),
      actor: "test-human",
      stateRoot,
      repositoryRoot: projectRoot,
    };

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
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const approvedPlan = fixturePlan(mainCommit);
    const gate1 = await approveGate1(
      {
        plan: approvedPlan,
        actor: "test-human",
        stateRoot,
        repositoryRoot: projectRoot,
      },
      await fixturePrompt(projectRoot, {
        isTTY: true,
        answer: approvedPlan.planSha256.slice(0, 12),
      }),
    );
    const changedPlan = fixturePlan(mainCommit, {
      validations: ["npm run check", "npm run lint"],
    });

    assert.throws(
      () => verifyApproval(gate1, changedPlan, mainCommit),
      /hash aprobado no coincide/i,
    );
  });
});

test("invalidates approval when main no longer equals its baseline", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const approvedPlan = fixturePlan(mainCommit);
    const gate1 = await approveGate1(
      {
        plan: approvedPlan,
        actor: "test-human",
        stateRoot,
        repositoryRoot: projectRoot,
      },
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
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const approvedPlan = fixturePlan(mainCommit);
    const approvedCandidate = fixtureCandidate(mainCommit, approvedPlan);
    await approveGate1(
      {
        plan: approvedPlan,
        actor: "test-human",
        stateRoot,
        repositoryRoot: projectRoot,
      },
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
        repositoryRoot: projectRoot,
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
      verifyApproval(gate2, approvedCandidate, mainCommit),
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
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    for (const actor of ["", "agent", "codex", "fixture", "ab"]) {
      const approvedPlan = fixturePlan(mainCommit);
      await assert.rejects(
        approveGate1(
          {
            plan: approvedPlan,
            actor,
            stateRoot,
            repositoryRoot: projectRoot,
          },
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
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const approvedPlan = fixturePlan(mainCommit);

    await assert.rejects(
      approveGate1(
        {
          plan: approvedPlan,
          actor: "test-human",
          stateRoot,
          repositoryRoot: projectRoot,
        },
        {
          isTTY: true,
          environment: "production",
          confirm: async () => approvedPlan.planSha256.slice(0, 12),
        } as unknown as FixtureApprovalPrompt,
      ),
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
  await withFixtureMode(async () => {
    await assert.rejects(
      createFixtureApprovalPrompt({
        projectRoot: process.cwd(),
        isTTY: true,
        answer: "irrelevant",
      }),
      /clon temporal|fixture/i,
    );
  });
});

test("refuses a lexical temporary symlink to an agent-worktree-like repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-symlink-"));
  try {
    const linkedRoot = join(root, "linked-repository");
    await symlink(process.cwd(), linkedRoot);
    await withFixtureMode(async () => {
      await assert.rejects(
        createFixtureApprovalPrompt({
          projectRoot: linkedRoot,
          isTTY: true,
          answer: "irrelevant",
        }),
        /clon temporal|symlink|enlace|fixture/i,
      );
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("refuses linked worktree pointers and generic Git initializations", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-untrusted-"));
  const worktree = join(root, "linked-worktree");
  const initialized = join(root, "initialized");
  try {
    await mkdir(worktree);
    await writeFile(
      join(worktree, ".git"),
      "gitdir: /outside/worktrees/linked\n",
    );
    await execFileAsync("git", ["init", "--quiet", initialized]);
    await withFixtureMode(async () => {
      for (const projectRoot of [worktree, initialized]) {
        await assert.rejects(
          createFixtureApprovalPrompt({
            projectRoot,
            isTTY: true,
            answer: "irrelevant",
          }),
          /clon temporal|Git|fixture|origin/i,
        );
      }
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("refuses a fixture root whose state directory is a symlink", async () => {
  await withStateRoot(async ({ projectRoot }) => {
    const foreignRoot = await mkdtemp(
      join(tmpdir(), "comunidadsolar-state-link-"),
    );
    try {
      await symlink(foreignRoot, join(projectRoot, ".change-state"));
      await withFixtureMode(async () => {
        await assert.rejects(
          createFixtureApprovalPrompt({
            projectRoot,
            isTTY: true,
            answer: "irrelevant",
          }),
          /estado|symlink|enlace|fixture/i,
        );
      });
    } finally {
      await rm(foreignRoot, { force: true, recursive: true });
    }
  });
});

test("fixture prompts cannot write approval state outside their temporary clone", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const foreignRoot = await mkdtemp(
      join(tmpdir(), "comunidadsolar-foreign-"),
    );
    try {
      const approvedPlan = fixturePlan(mainCommit);
      await assert.rejects(
        approveGate1(
          {
            plan: approvedPlan,
            actor: "test-human",
            stateRoot: join(foreignRoot, ".change-state"),
            repositoryRoot: projectRoot,
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
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const approvedPlan = fixturePlan(mainCommit);
    const approvedCandidate = fixtureCandidate(mainCommit, approvedPlan);

    await assert.rejects(
      approveGate2(
        {
          plan: approvedPlan,
          candidate: approvedCandidate,
          actor: "test-human",
          stateRoot,
          repositoryRoot: projectRoot,
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

test("Gate 2 reads advanced main instead of a caller-supplied old baseline", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const approvedPlan = fixturePlan(mainCommit);
    const approvedCandidate = fixtureCandidate(mainCommit, approvedPlan);
    await approveGate1(
      {
        plan: approvedPlan,
        actor: "test-human",
        stateRoot,
        repositoryRoot: projectRoot,
      },
      await fixturePrompt(projectRoot, {
        isTTY: true,
        answer: approvedPlan.planSha256.slice(0, 12),
      }),
    );
    const gate2Prompt = await fixturePrompt(projectRoot, {
      isTTY: true,
      answer: sha256Canonical(approvedCandidate).slice(0, 12),
    });
    await writeFile(join(projectRoot, "advanced.txt"), "advanced\n", "utf8");
    await execFileAsync("git", ["-C", projectRoot, "add", "advanced.txt"]);
    await execFileAsync("git", [
      "-C",
      projectRoot,
      "commit",
      "--quiet",
      "-m",
      "advance main",
    ]);

    await assert.rejects(
      approveGate2(
        {
          plan: approvedPlan,
          candidate: approvedCandidate,
          actor: "test-human",
          stateRoot,
          repositoryRoot: projectRoot,
        },
        gate2Prompt,
      ),
      /baseline/i,
    );
  });
});

test("approval issuance fails closed for missing repository roots", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const approvedPlan = fixturePlan(mainCommit);
    await assert.rejects(
      approveGate1(
        {
          plan: approvedPlan,
          actor: "test-human",
          stateRoot,
          repositoryRoot: join(projectRoot, "missing"),
        },
        await fixturePrompt(projectRoot, {
          isTTY: true,
          answer: approvedPlan.planSha256.slice(0, 12),
        }),
      ),
      /repositorio|main|Git/i,
    );
  });
});

test("Gate 2 rejects candidates from a different request or build profile", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const approvedPlan = fixturePlan(mainCommit);
    await approveGate1(
      {
        plan: approvedPlan,
        actor: "test-human",
        stateRoot,
        repositoryRoot: projectRoot,
      },
      await fixturePrompt(projectRoot, {
        isTTY: true,
        answer: approvedPlan.planSha256.slice(0, 12),
      }),
    );

    for (const invalidCandidate of [
      fixtureCandidate(mainCommit, approvedPlan, {
        requestSha256: hash("d"),
      }),
      fixtureCandidate(mainCommit, approvedPlan, {
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
            repositoryRoot: projectRoot,
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
    baselineCommit: defaultBaselineCommit,
    candidateCommit: null,
    artifactSha256: null,
  };

  for (const actor of ["", "agent", "codex", "fixture", " test-human "]) {
    assert.throws(
      () =>
        verifyApproval(
          { ...validRecord, actor },
          approvedPlan,
          defaultBaselineCommit,
        ),
      /actor|identidad/i,
    );
  }
});
