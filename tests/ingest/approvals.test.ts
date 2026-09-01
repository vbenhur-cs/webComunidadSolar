import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdtemp,
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
import { sanitizedGitEnv } from "../../src/ingest/git-env.ts";
import { ingestPaths } from "../../src/ingest/paths.ts";
import {
  approveGate1,
  approveGate2,
  verifyApproval,
} from "../../src/ingest/approvals/service.ts";
import {
  createControllerApprovalTestPrompt,
  createFixtureApprovalRun,
  type FixtureApprovalRun,
  type FixtureApprovalPrompt,
} from "../../src/ingest/approvals/prompt.ts";

const hash = (character: string) => character.repeat(64);
const defaultBaselineCommit = "b".repeat(40);
const execFileAsync = promisify(execFile);
const fixtureRuns = new Map<string, FixtureApprovalRun>();

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
  const fixture = fixtureRuns.get(projectRoot);
  if (fixture === undefined)
    throw new TypeError("No existe un fixture de aprobación para este clon");
  return fixture.createPrompt({
    isTTY: options.isTTY,
    answer: options.answer ?? "",
  });
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

async function withHostileGitEnvironment(
  gitDir: string,
  run: () => Promise<void>,
): Promise<void> {
  const overrides = {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: "/attacker-controlled-work-tree",
    git_dir: gitDir,
    GiT_WoRk_TrEe: "/attacker-controlled-work-tree",
  };
  const previous = new Map(
    Object.keys(overrides).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, overrides);
  try {
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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
  let fixture: FixtureApprovalRun | undefined;
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
    await withFixtureMode(async () => {
      fixture = await createFixtureApprovalRun({ fixtureSourceRoot: origin });
    });
    const activeFixture = fixture;
    if (activeFixture === undefined)
      throw new Error("No se creó el fixture de aprobación");
    const clone = activeFixture.repositoryRoot;
    fixtureRuns.set(clone, activeFixture);
    const { stdout } = await execFileAsync("git", [
      "-C",
      clone,
      "rev-parse",
      "HEAD",
    ]);
    await run({
      projectRoot: clone,
      stateRoot: activeFixture.stateRoot,
      mainCommit: stdout.trim(),
    });
  } finally {
    if (fixture !== undefined) {
      fixtureRuns.delete(fixture.repositoryRoot);
      await fixture.dispose();
    }
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

test("removes case variants of Git environment overrides", () => {
  const names = ["git_dir", "GiT_WoRk_TrEe"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    process.env.git_dir = "/attacker/.git";
    process.env.GiT_WoRk_TrEe = "/attacker/worktree";
    const safeEnvironment = sanitizedGitEnv();
    for (const name of names) assert.equal(safeEnvironment[name], undefined);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("ignores hostile GIT_DIR and GIT_WORK_TREE for fixtures and main authority", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const attacker = await mkdtemp(join(tmpdir(), "comunidadsolar-attacker-"));
    try {
      await execFileAsync("git", [
        "init",
        "--quiet",
        "--initial-branch=main",
        attacker,
      ]);
      await execFileAsync("git", [
        "-C",
        attacker,
        "config",
        "user.email",
        "attacker@example.test",
      ]);
      await execFileAsync("git", [
        "-C",
        attacker,
        "config",
        "user.name",
        "Attacker",
      ]);
      await writeFile(join(attacker, "attack.txt"), "attack\n", "utf8");
      await execFileAsync("git", ["-C", attacker, "add", "attack.txt"]);
      await execFileAsync("git", [
        "-C",
        attacker,
        "commit",
        "--quiet",
        "-m",
        "attacker main",
      ]);
      const approvedPlan = fixturePlan(mainCommit);

      await withHostileGitEnvironment(join(attacker, ".git"), async () => {
        await withFixtureMode(async () => {
          const nestedFixture = await createFixtureApprovalRun({
            fixtureSourceRoot: projectRoot,
          });
          await nestedFixture.dispose();
        });
        await assert.doesNotReject(
          approveGate1(
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
          ),
        );
      });
    } finally {
      await rm(attacker, { force: true, recursive: true });
    }
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
      createFixtureApprovalRun({ fixtureSourceRoot: projectRoot }),
      /INGEST_TEST_MODE|fixture/i,
    );
  });
});

test("refuses to mint the controller test authority outside explicit test mode", () => {
  const previous = process.env.INGEST_TEST_MODE;
  delete process.env.INGEST_TEST_MODE;
  try {
    assert.throws(
      () => createControllerApprovalTestPrompt({ answer: "0123456789ab" }),
      /modo de pruebas|test/i,
    );
  } finally {
    if (previous === undefined) delete process.env.INGEST_TEST_MODE;
    else process.env.INGEST_TEST_MODE = previous;
  }
});

test("refuses a symlink fixture source", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-symlink-"));
  try {
    const linkedRoot = join(root, "linked-repository");
    await symlink(process.cwd(), linkedRoot);
    await withFixtureMode(async () => {
      await assert.rejects(
        createFixtureApprovalRun({ fixtureSourceRoot: linkedRoot }),
        /fuente|symlink|enlace|fixture/i,
      );
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("does not mint a fixture capability for a forged initialized source", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-untrusted-"));
  const initialized = join(root, "initialized");
  let fixture: FixtureApprovalRun | undefined;
  try {
    await execFileAsync("git", [
      "init",
      "--quiet",
      "--initial-branch=main",
      initialized,
    ]);
    await execFileAsync("git", [
      "-C",
      initialized,
      "config",
      "user.email",
      "forged@example.test",
    ]);
    await execFileAsync("git", [
      "-C",
      initialized,
      "config",
      "user.name",
      "Forged source",
    ]);
    await writeFile(join(initialized, "README.md"), "forged\n", "utf8");
    await execFileAsync("git", ["-C", initialized, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      initialized,
      "commit",
      "--quiet",
      "-m",
      "forged source",
    ]);
    await execFileAsync("git", [
      "-C",
      initialized,
      "remote",
      "add",
      "origin",
      "https://example.test/forged.git",
    ]);
    await execFileAsync("git", [
      "-C",
      initialized,
      "update-ref",
      "refs/remotes/origin/main",
      "HEAD",
    ]);
    await withFixtureMode(async () => {
      fixture = await createFixtureApprovalRun({
        fixtureSourceRoot: initialized,
      });
      const activeFixture = fixture;
      if (activeFixture === undefined) throw new Error("No se creó el fixture");
      const { stdout } = await execFileAsync("git", [
        "-C",
        activeFixture.repositoryRoot,
        "rev-parse",
        "refs/heads/main",
      ]);
      const forgedPlan = fixturePlan(stdout.trim());
      const prompt = await activeFixture.createPrompt({
        isTTY: true,
        answer: forgedPlan.planSha256.slice(0, 12),
      });

      assert.notEqual(activeFixture.repositoryRoot, initialized);
      await assert.rejects(
        approveGate1(
          {
            plan: forgedPlan,
            actor: "test-human",
            stateRoot: join(initialized, ".change-state"),
            repositoryRoot: initialized,
          },
          prompt,
        ),
        /solo puede leer main|solo puede escribir estado/i,
      );
    });
    await assert.rejects(lstat(join(initialized, ".change-state")), {
      code: "ENOENT",
    });
  } finally {
    await fixture?.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("does not mint fixture prompts through a symlinked state directory", async () => {
  await withStateRoot(async ({ projectRoot }) => {
    const foreignRoot = await mkdtemp(
      join(tmpdir(), "comunidadsolar-state-link-"),
    );
    try {
      await symlink(foreignRoot, join(projectRoot, ".change-state"));
      await assert.rejects(
        fixturePrompt(projectRoot, { isTTY: true, answer: "irrelevant" }),
        /estado|symlink|enlace|fixture/i,
      );
    } finally {
      await rm(foreignRoot, { force: true, recursive: true });
    }
  });
});

test("revokes a fixture capability when its run is disposed", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const approvedPlan = fixturePlan(mainCommit);
    const prompt = await fixturePrompt(projectRoot, {
      isTTY: true,
      answer: approvedPlan.planSha256.slice(0, 12),
    });
    const fixture = fixtureRuns.get(projectRoot);
    if (fixture === undefined) throw new Error("No se creó el fixture");
    await fixture.dispose();

    await assert.rejects(
      approveGate1(
        {
          plan: approvedPlan,
          actor: "test-human",
          stateRoot,
          repositoryRoot: projectRoot,
        },
        prompt,
      ),
      /prompt de aprobaci[oó]n|capacidad/i,
    );
    await assert.rejects(lstat(projectRoot), { code: "ENOENT" });
  });
});

test("dispose waits for a paused fixture approval and removes its state", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const approvedPlan = fixturePlan(mainCommit);
    const fixture = fixtureRuns.get(projectRoot);
    if (fixture === undefined) throw new Error("No se creó el fixture");
    let markPersistEntered: (() => void) | undefined;
    const persistEntered = new Promise<void>((resolve) => {
      markPersistEntered = resolve;
    });
    let releasePersist: (() => void) | undefined;
    const persistReleased = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const promptOptions = {
      isTTY: true,
      answer: approvedPlan.planSha256.slice(0, 12),
      beforePersist: async () => {
        markPersistEntered?.();
        await persistReleased;
      },
    };
    const prompt = await fixture.createPrompt(promptOptions);
    const { stdout: origin } = await execFileAsync("git", [
      "-C",
      projectRoot,
      "remote",
      "get-url",
      "origin",
    ]);
    const approval = approveGate1(
      {
        plan: approvedPlan,
        actor: "test-human",
        stateRoot,
        repositoryRoot: projectRoot,
      },
      prompt,
    );
    const phase = await Promise.race([
      approval.then(() => "approved"),
      persistEntered.then(() => "paused"),
    ]);
    assert.equal(phase, "paused");
    await rm(projectRoot, { force: true, recursive: true });
    await execFileAsync("git", [
      "clone",
      "--quiet",
      "--branch",
      "main",
      origin.trim(),
      projectRoot,
    ]);

    let disposeResolved = false;
    const disposal = fixture.dispose().then(() => {
      disposeResolved = true;
    });
    await new Promise(setImmediate);
    assert.equal(disposeResolved, false);
    releasePersist?.();

    await approval;
    await disposal;
    await assert.rejects(lstat(projectRoot), { code: "ENOENT" });
    await assert.rejects(
      approveGate1(
        {
          plan: approvedPlan,
          actor: "test-human",
          stateRoot,
          repositoryRoot: projectRoot,
        },
        prompt,
      ),
      /prompt de aprobaci[oó]n|capacidad/i,
    );
  });
});

test("rejects a fixture capability after its clone path is recreated", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const approvedPlan = fixturePlan(mainCommit);
    const prompt = await fixturePrompt(projectRoot, {
      isTTY: true,
      answer: approvedPlan.planSha256.slice(0, 12),
    });
    const { stdout: origin } = await execFileAsync("git", [
      "-C",
      projectRoot,
      "remote",
      "get-url",
      "origin",
    ]);
    await rm(projectRoot, { force: true, recursive: true });
    await execFileAsync("git", [
      "clone",
      "--quiet",
      "--branch",
      "main",
      origin.trim(),
      projectRoot,
    ]);

    await assert.rejects(
      approveGate1(
        {
          plan: approvedPlan,
          actor: "test-human",
          stateRoot,
          repositoryRoot: projectRoot,
        },
        prompt,
      ),
      /fixture|identidad|clon/i,
    );
    await assert.rejects(lstat(stateRoot), { code: "ENOENT" });
  });
});

test("rejects an owned clone whose Git common directory leaves its root", async () => {
  await withStateRoot(async ({ projectRoot, stateRoot, mainCommit }) => {
    const external = await mkdtemp(join(tmpdir(), "comunidadsolar-common-"));
    try {
      const approvedPlan = fixturePlan(mainCommit);
      const prompt = await fixturePrompt(projectRoot, {
        isTTY: true,
        answer: approvedPlan.planSha256.slice(0, 12),
      });
      const { stdout: origin } = await execFileAsync("git", [
        "-C",
        projectRoot,
        "remote",
        "get-url",
        "origin",
      ]);
      await rm(external, { force: true, recursive: true });
      await execFileAsync("git", [
        "clone",
        "--quiet",
        "--branch",
        "main",
        origin.trim(),
        external,
      ]);
      await writeFile(
        join(projectRoot, ".git", "commondir"),
        `${join(external, ".git")}\n`,
        "utf8",
      );

      await assert.rejects(
        approveGate1(
          {
            plan: approvedPlan,
            actor: "test-human",
            stateRoot,
            repositoryRoot: projectRoot,
          },
          prompt,
        ),
        /Git|repositorio|fixture|clon/i,
      );
      await assert.rejects(
        approveGate1({
          plan: approvedPlan,
          actor: "test-human",
          stateRoot,
          repositoryRoot: projectRoot,
        }),
        /Git|repositorio|independiente/i,
      );
      await assert.rejects(lstat(stateRoot), { code: "ENOENT" });
    } finally {
      await rm(external, { force: true, recursive: true });
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
