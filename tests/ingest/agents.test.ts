import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { sha256Canonical } from "../../src/ingest/canonical-json.ts";
import type { ChangePlan } from "../../src/ingest/domain.ts";
import { CommandAgent } from "../../src/ingest/agents/command.ts";
import {
  CodexAgent,
  codexInvocation,
  createCodexExecutableCapability,
} from "../../src/ingest/agents/codex.ts";
import {
  createOperatorIsolationBroker,
  testIsolationBroker,
} from "../../src/ingest/agents/isolation.ts";
import { createFixtureAgentRun } from "../../src/ingest/agents/fixture.ts";
import type {
  AgentRunInput,
  BrokerRunInput,
  IsolationBroker,
} from "../../src/ingest/agents/types.ts";
import {
  assertTrustedRepositoriesUnchanged,
  assertWorkspaceInputs,
  createAgentWorkspace,
  removeAgentWorkspace,
  workspaceInputs,
  workspaceManifest,
  type AgentWorkspace,
  type AgentWorkspaceInput,
} from "../../src/ingest/workspaces/service.ts";
import {
  removeStagedAgentOutput,
  validateAgentWorkspaceOutput,
} from "../../src/ingest/workspaces/policy.ts";

process.env.INGEST_TEST_MODE ??= "true";

const execFileAsync = promisify(execFile);
const hash = (character: string) => character.repeat(64);
const fixtureAgent = join(
  process.cwd(),
  "tests",
  "fixtures",
  "ingestion",
  "command-agent.mjs",
);

function request() {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId: "agent-isolation",
    inputKind: "request" as const,
    intent: "Generate a safe page",
    audience: null,
    targetPath: "/generated" as const,
    mode: "blocks" as const,
    content: "safe input",
    claims: [],
    references: [],
    assets: [],
    seo: { title: null, description: null, index: false },
    privacy: { private: false, area: null },
    allowedExternalLinks: [],
    acceptanceCriteria: ["A page exists"],
  };
  return { ...unsigned, inputSha256: sha256Canonical(unsigned) };
}

function plan(baselineCommit: string): ChangePlan {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId: "agent-isolation",
    baselineCommit,
    requestSha256: request().inputSha256,
    selectedMode: "blocks" as const,
    targetPath: "/generated" as const,
    overwritesExistingRoute: false,
    files: [
      {
        path: "src/pages/generated.astro",
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
  };
  return { ...unsigned, planSha256: sha256Canonical(unsigned) };
}

function planWith(
  baselineCommit: string,
  changes: Partial<Omit<ChangePlan, "planSha256">>,
): ChangePlan {
  const { planSha256: ignored, ...base } = plan(baselineCommit);
  void ignored;
  const unsigned = { ...base, ...changes };
  return { ...unsigned, planSha256: sha256Canonical(unsigned) };
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

interface WorkspaceRepository {
  root: string;
  sourceRoot: string;
  baseline: string;
  workspaceRoot: string;
  requestPath: string;
  planPath: string;
  policyPath: string;
  resultSchemaPath: string;
}

async function initializeRepository(root: string): Promise<void> {
  await execFileAsync("git", [
    "init",
    "--quiet",
    "--initial-branch=main",
    root,
  ]);
  await git(root, ["config", "user.email", "fixture@example.test"]);
  await git(root, ["config", "user.name", "Fixture Human"]);
}

async function withWorkspaceRepository(
  run: (repository: WorkspaceRepository) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-workspace-repo-"));
  const sourceRoot = await mkdtemp(
    join(tmpdir(), "comunidadsolar-workspace-source-"),
  );
  const workspaceRoot = await realpath(
    await mkdtemp(join(tmpdir(), "comunidadsolar-workspaces-")),
  );
  const authorityRoot = await mkdtemp(
    join(tmpdir(), "comunidadsolar-workspace-inputs-"),
  );
  try {
    await Promise.all([
      initializeRepository(root),
      initializeRepository(sourceRoot),
    ]);
    await Promise.all([
      writeFile(join(root, "README.md"), "fixture\n", "utf8"),
      mkdir(join(root, ".change-state")),
      mkdir(join(root, ".wrangler", "deploy"), { recursive: true }),
      writeFile(join(root, ".env"), "TOKEN=must-not-be-exported\n", "utf8"),
      writeFile(
        join(root, ".env.example"),
        "SENTINEL_SECRET=must-not-be-exported\n",
        "utf8",
      ),
      writeFile(join(root, "wrangler.jsonc"), '{"name":"publish"}\n', "utf8"),
      writeFile(join(sourceRoot, "SOURCE_ONLY.md"), "source sibling\n", "utf8"),
    ]);
    await Promise.all([
      writeFile(
        join(root, ".change-state", "state.json"),
        '{"private":true}\n',
        "utf8",
      ),
      writeFile(
        join(root, ".wrangler", "deploy", "config.json"),
        '{"binding":"production"}\n',
        "utf8",
      ),
    ]);
    await git(root, ["add", "-f", "."]);
    await git(sourceRoot, ["add", "."]);
    await Promise.all([
      git(root, ["commit", "--quiet", "-m", "workspace baseline"]),
      git(sourceRoot, ["commit", "--quiet", "-m", "source baseline"]),
    ]);
    const baseline = await git(root, ["rev-parse", "HEAD"]);
    const requestPath = join(authorityRoot, "request.json");
    const planPath = join(authorityRoot, "plan.json");
    const policyPath = join(authorityRoot, "policy.json");
    const resultSchemaPath = join(authorityRoot, "agent-result.schema.json");
    await Promise.all([
      writeFile(requestPath, JSON.stringify(request()), "utf8"),
      writeFile(planPath, JSON.stringify(plan(baseline)), "utf8"),
      writeFile(policyPath, '{"allow":"planned-only"}', "utf8"),
      writeFile(resultSchemaPath, '{"type":"object"}', "utf8"),
    ]);
    await run({
      root,
      sourceRoot,
      baseline,
      workspaceRoot,
      requestPath,
      planPath,
      policyPath,
      resultSchemaPath,
    });
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
      rm(workspaceRoot, { recursive: true, force: true }),
      rm(authorityRoot, { recursive: true, force: true }),
    ]);
  }
}

function workspaceInput(repository: WorkspaceRepository): AgentWorkspaceInput {
  return {
    repositoryRoot: repository.root,
    sourceRepositoryRoot: repository.sourceRoot,
    workspaceRoot: repository.workspaceRoot,
    approvedPlan: plan(repository.baseline),
    changeId: "agent-isolation",
    attemptId: "attempt-000001",
    baselineCommit: repository.baseline,
    requestPath: repository.requestPath,
    planPath: repository.planPath,
    policyPath: repository.policyPath,
    resultSchemaPath: repository.resultSchemaPath,
  };
}

async function createWorkspaceForPlan(
  repository: WorkspaceRepository,
  approvedPlan: ChangePlan,
): Promise<AgentWorkspace> {
  await writeFile(repository.planPath, JSON.stringify(approvedPlan), "utf8");
  return await createAgentWorkspace({
    ...workspaceInput(repository),
    approvedPlan,
  });
}

function agentInput(workspace: AgentWorkspace): AgentRunInput {
  return workspaceInputs(workspace);
}

async function withAgentWorkspace(
  run: (
    workspace: AgentWorkspace,
    repository: WorkspaceRepository,
  ) => Promise<void>,
): Promise<void> {
  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    try {
      await run(workspace, repository);
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
}

async function exists(path: string): Promise<boolean> {
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

async function writeSparseFile(path: string, bytes: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try {
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
}

function recordingBroker(): IsolationBroker {
  return createOperatorIsolationBroker(async () => ({
    exitCode: 0,
    stdout: '{"generatedFiles":[]}',
    stderr: "",
    timedOut: false,
  }));
}

test("Codex runs ephemeral in workspace-write without bypass flags", async () => {
  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    try {
      const invocation = codexInvocation(workspace, agentInput(workspace));
      assert.equal(invocation.command, "codex");
      assert.deepEqual(invocation.args.slice(0, 6), [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--sandbox",
        "workspace-write",
        "--cd",
      ]);
      assert.ok(invocation.args.includes("--json"));
      assert.ok(invocation.args.includes("-"));
      assert.ok(
        invocation.args.includes(
          join(workspace.path, ".agent-output", "final-message.json"),
        ),
      );
      assert.ok(
        !invocation.args.some((arg) => arg.includes("dangerously-bypass")),
      );
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("command adapter delegates one complete argv-only job to the broker", async () => {
  await withAgentWorkspace(async (workspace) => {
    const calls: BrokerRunInput[] = [];
    const broker = createOperatorIsolationBroker(async (brokerInput) => {
      calls.push(brokerInput);
      return {
        exitCode: 0,
        stdout: '{"generatedFiles":[]}',
        stderr: "",
        timedOut: false,
      };
    });
    await new CommandAgent(
      {
        command: process.execPath,
        args: [fixtureAgent],
        timeoutMs: 5_000,
      },
      broker,
      workspace,
    ).run(agentInput(workspace));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.workspace, workspace.path);
    assert.deepEqual(calls[0]?.env, {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
    });
    assert.equal(calls[0]?.args.includes("--shell"), false);
    assert.equal(calls[0]?.timeoutMs, 5_000);
  });
});

test("command adapter is bound to one service-owned agent workspace", async () => {
  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    const calls: BrokerRunInput[] = [];
    const broker = createOperatorIsolationBroker(async (brokerInput) => {
      calls.push(brokerInput);
      return {
        exitCode: 0,
        stdout: '{"generatedFiles":[]}',
        stderr: "",
        timedOut: false,
      };
    });
    const agent = new CommandAgent(
      { command: process.execPath, args: [] },
      broker,
      workspace,
    );
    try {
      await agent.run(agentInput(workspace));
      await assert.rejects(
        agent.run({
          ...agentInput(workspace),
          requestPath: join(repository.sourceRoot, "forged-request.json"),
        }),
        /workspace aprobado|contexto.*workspace/i,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.workspace, workspace.path);
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("production command adapter rejects no broker and a structural broker", async () => {
  await withAgentWorkspace(async (workspace) => {
    const config = { command: process.execPath, args: [fixtureAgent] };
    const result = {
      exitCode: 0,
      stdout: '{"generatedFiles":[]}',
      stderr: "",
      timedOut: false,
    };
    const input = agentInput(workspace);
    await assert.rejects(
      () => new CommandAgent(config, null, workspace).run(input),
      /broker/i,
    );
    await assert.rejects(
      () =>
        new CommandAgent(
          config,
          { run: async () => result } as never,
          workspace,
        ).run(input),
      /broker/i,
    );
  });
});

test("broker timeout and non-zero exit never produce generated files", async () => {
  await withAgentWorkspace(async (workspace) => {
    const input = agentInput(workspace);
    const config = { command: process.execPath, args: [fixtureAgent] };
    const timedOut = createOperatorIsolationBroker(async () => ({
      exitCode: 124,
      stdout: "",
      stderr: "deadline",
      timedOut: true,
    }));
    const nonZero = createOperatorIsolationBroker(async () => ({
      exitCode: 1,
      stdout: '{"generatedFiles":["must-not-be-returned.astro"]}',
      stderr: "failed",
      timedOut: false,
    }));
    await assert.rejects(
      () => new CommandAgent(config, timedOut, workspace).run(input),
      /timeout/i,
    );
    await assert.rejects(
      () => new CommandAgent(config, nonZero, workspace).run(input),
      /código de salida/i,
    );
  });
});

test("command adapter rejects oversized broker stdout and stderr", async () => {
  await withAgentWorkspace(async (workspace) => {
    const input = agentInput(workspace);
    const config = { command: process.execPath, args: [] };
    await assert.rejects(
      new CommandAgent(
        config,
        createOperatorIsolationBroker(async () => ({
          exitCode: 0,
          stdout: "x".repeat(262_145),
          stderr: "",
          timedOut: false,
        })),
        workspace,
      ).run(input),
      /stdout.*l[ií]mite|l[ií]mite.*stdout/i,
    );
    await assert.rejects(
      new CommandAgent(
        config,
        createOperatorIsolationBroker(async () => ({
          exitCode: 0,
          stdout: '{"generatedFiles":[]}',
          stderr: "x".repeat(262_145),
          timedOut: false,
        })),
        workspace,
      ).run(input),
      /stderr.*l[ií]mite|l[ií]mite.*stderr/i,
    );
  });
});

test("test isolation broker terminates an argv job at its supplied deadline", async () => {
  const workspace = await mkdtemp(
    join(tmpdir(), "comunidadsolar-test-broker-timeout-"),
  );
  const broker = testIsolationBroker(workspace);
  const started = Date.now();
  try {
    const result = await broker.run({
      workspace,
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 250)"],
      stdin: "",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeoutMs: 40,
    });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 200);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("test isolation broker rejects stdout beyond its capture ceiling", async () => {
  const workspace = await mkdtemp(
    join(tmpdir(), "comunidadsolar-test-broker-output-limit-"),
  );
  const broker = testIsolationBroker(workspace);
  try {
    await assert.rejects(
      broker.run({
        workspace,
        command: process.execPath,
        args: ["-e", 'process.stdout.write("x".repeat(262145))'],
        stdin: "",
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        timeoutMs: 5_000,
      }),
      /stdout.*l[ií]mite|l[ií]mite.*stdout/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("test isolation broker rejects a timeout above the trusted hard cap", async () => {
  const workspace = await mkdtemp(
    join(tmpdir(), "comunidadsolar-test-broker-timeout-cap-"),
  );
  const broker = testIsolationBroker(workspace);
  try {
    await assert.rejects(
      broker.run({
        workspace,
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        stdin: "",
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        timeoutMs: 300_001,
      }),
      /timeout.*l[ií]mite|l[ií]mite.*timeout/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test(
  "test isolation broker terminates a pipe-holding descendant after its leader exits",
  { skip: process.platform === "win32" },
  async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "comunidadsolar-test-broker-group-timeout-"),
    );
    const broker = testIsolationBroker(workspace);
    const leader = [
      'const { spawn } = require("node:child_process");',
      `spawn(${JSON.stringify(process.execPath)}, ["-e", "setTimeout(() => process.exit(0), 500)"], { stdio: "inherit" });`,
      "setTimeout(() => process.exit(0), 10);",
    ].join("");
    const started = Date.now();
    try {
      const result = await broker.run({
        workspace,
        command: process.execPath,
        args: ["-e", leader],
        stdin: "",
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        timeoutMs: 80,
      });
      assert.equal(result.timedOut, true);
      assert.ok(Date.now() - started < 300);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

test("command adapter refuses to run without an isolation broker", async () => {
  await withAgentWorkspace(async (workspace) => {
    await assert.rejects(
      new CommandAgent(
        { command: process.execPath, args: [fixtureAgent] },
        null,
        workspace,
      ).run(agentInput(workspace)),
      /isolation broker/i,
    );
  });
});

test("exports the approved baseline into a disposable workspace without Git or operational state", async () => {
  await withWorkspaceRepository(async (repository) => {
    const expectedPath = join(
      repository.workspaceRoot,
      "agent-isolation",
      "attempt-000001",
    );
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    try {
      assert.equal(workspace.path, expectedPath);
      assert.equal(
        await readFile(join(workspace.path, "README.md"), "utf8"),
        "fixture\n",
      );
      for (const forbidden of [
        ".git",
        ".change-state",
        ".env",
        ".env.example",
        ".wrangler",
        "wrangler.jsonc",
        "SOURCE_ONLY.md",
      ]) {
        assert.equal(await exists(join(workspace.path, forbidden)), false);
      }
      assert.equal(await exists(join(workspace.path, ".agent-output")), true);
      assert.deepEqual(workspaceInputs(workspace), {
        changeId: "agent-isolation",
        attemptId: "attempt-000001",
        workspace: expectedPath,
        requestPath: join(expectedPath, ".agent-input", "request.json"),
        planPath: join(expectedPath, ".agent-input", "plan.json"),
        policyPath: join(expectedPath, ".agent-input", "policy.json"),
        resultSchemaPath: join(
          expectedPath,
          ".agent-input",
          "agent-result.schema.json",
        ),
      });
      const currentManifest = await workspaceManifest(workspace);
      assert.equal(currentManifest.has(".env.example"), false);
      assert.deepEqual([...currentManifest.keys()], ["README.md"]);
      assert.deepEqual(
        [...currentManifest.entries()],
        [...workspace.baselineManifest.entries()],
      );
    } finally {
      await removeAgentWorkspace(workspace);
    }
    assert.equal(await exists(expectedPath), false);
  });
});

test("agent workspace API exposes no Git worktree or candidate-ref authority", async () => {
  const [workspaceSource, commandSource, gitignoreSource] = await Promise.all([
    readFile("src/ingest/workspaces/service.ts", "utf8"),
    readFile("src/ingest/agents/command.ts", "utf8"),
    readFile(".gitignore", "utf8"),
  ]);
  assert.doesNotMatch(workspaceSource, /git worktree add|candidate\//u);
  assert.doesNotMatch(commandSource, /(?:ingest\/|\.\.\/)worktrees\//u);
  assert.doesNotMatch(gitignoreSource, /^\.agent-worktrees\/$/mu);

  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    try {
      assert.equal(await exists(join(workspace.path, ".git")), false);
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("rejects an oversized authoritative agent input before copying it", async () => {
  await withWorkspaceRepository(async (repository) => {
    await writeFile(repository.policyPath, Buffer.alloc(1_048_577, 0x78));
    await assert.rejects(async () => {
      const workspace = await createAgentWorkspace(workspaceInput(repository));
      await removeAgentWorkspace(workspace);
      assert.fail("expected the input size ceiling to reject the workspace");
    }, /entrada|policy.*l[ií]mite|excede/i);
  });
});

test("copies authoritative inputs without owner, group, or other write permission", async () => {
  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    try {
      const inputDirectory = dirname(workspace.requestPath);
      assert.equal((await stat(inputDirectory)).mode & 0o222, 0);
      for (const path of [
        workspace.requestPath,
        workspace.planPath,
        workspace.policyPath,
        workspace.resultSchemaPath,
      ]) {
        assert.equal((await stat(path)).mode & 0o222, 0);
      }
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("rejects a mutated copied request before accepting output", async () => {
  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    try {
      await chmod(dirname(workspace.requestPath), 0o700);
      await chmod(workspace.requestPath, 0o600);
      await writeFile(workspace.requestPath, '{"changed":true}', "utf8");
      await assert.rejects(
        () => assertWorkspaceInputs(workspace),
        /entrada copiada/i,
      );
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("requires a fresh target and does not delete an occupied directory", async () => {
  await withWorkspaceRepository(async (repository) => {
    const expectedPath = join(
      repository.workspaceRoot,
      "agent-isolation",
      "attempt-000001",
    );
    await mkdir(expectedPath, { recursive: true });
    await writeFile(join(expectedPath, "owner.txt"), "someone else", "utf8");
    await assert.rejects(
      () => createAgentWorkspace(workspaceInput(repository)),
      /ocupado/i,
    );
    assert.equal(
      await readFile(join(expectedPath, "owner.txt"), "utf8"),
      "someone else",
    );
  });
});

test("rejects unsafe workspace identifiers before deriving their paths", async () => {
  await withWorkspaceRepository(async (repository) => {
    for (const [field, value] of [
      ["changeId", "../escape"],
      ["changeId", "Agent-Isolation"],
      ["attemptId", "ab"],
      ["attemptId", "attempt/000001"],
    ] as const) {
      await assert.rejects(
        () =>
          createAgentWorkspace({
            ...workspaceInput(repository),
            [field]: value,
          }),
        /identificador/i,
      );
    }
  });
});

test("records and rejects controller or source-repository drift around an attempt", async () => {
  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    const controllerDrift = join(repository.root, "outside.txt");
    try {
      await writeFile(controllerDrift, "changed", "utf8");
      await assert.rejects(
        () => assertTrustedRepositoriesUnchanged(workspace),
        /repositorio.*cambi[oó]/i,
      );
      await rm(controllerDrift);
      await assert.doesNotReject(() =>
        assertTrustedRepositoriesUnchanged(workspace),
      );
      await writeFile(
        join(repository.sourceRoot, "outside.txt"),
        "changed",
        "utf8",
      );
      await assert.rejects(
        () => assertTrustedRepositoriesUnchanged(workspace),
        /repositorio.*cambi[oó]/i,
      );
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("cleanup removes only an owned workspace object", async () => {
  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    await assert.rejects(
      () => removeAgentWorkspace({ ...workspace }),
      /workspace.*pertenece|propiedad/i,
    );
    assert.equal(await exists(workspace.path), true);
    await removeAgentWorkspace(workspace);
    assert.equal(await exists(workspace.path), false);
  });
});

test("builds accepted inventory independently and byte-copies it into a clean baseline", async () => {
  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    const generated = join(workspace.path, "src/pages/generated.astro");
    await mkdir(dirname(generated), { recursive: true });
    await writeFile(generated, "---\n---\n<h1>x</h1>", "utf8");

    const staged = await validateAgentWorkspaceOutput(
      workspace,
      plan(repository.baseline),
    );
    let stagedRemoved = false;
    let workspaceRemoved = false;
    try {
      const copied = join(staged.path, "src/pages/generated.astro");
      const stagingRoot = dirname(staged.path);
      assert.deepEqual(Object.keys(staged).sort(), ["files", "path", "sha256"]);
      assert.equal("workspace" in staged, false);
      assert.notEqual(stagingRoot, dirname(workspace.path));
      assert.equal(basename(stagingRoot).includes(workspace.changeId), false);
      assert.equal(basename(stagingRoot).includes(workspace.attemptId), false);
      assert.equal(basename(staged.path).includes(workspace.changeId), false);
      assert.equal(basename(staged.path).includes(workspace.attemptId), false);
      assert.ok(relative(stagingRoot, workspace.path).startsWith(".."));
      assert.equal(await exists(join(stagingRoot, workspace.attemptId)), false);
      assert.deepEqual(await readdir(stagingRoot), [basename(staged.path)]);
      assert.notEqual(staged.path, workspace.path);
      assert.deepEqual(staged.files, ["src/pages/generated.astro"]);
      assert.equal(
        staged.sha256["src/pages/generated.astro"],
        "03e11ae7fe4831a674ed9286bc5ad0b6c1b11b76c11fbf1247d337d7270e3372",
      );
      assert.equal(await readFile(copied, "utf8"), "---\n---\n<h1>x</h1>");
      assert.equal(
        await readFile(join(staged.path, "README.md"), "utf8"),
        "fixture\n",
      );
      assert.equal(await exists(join(staged.path, ".agent-input")), false);
      assert.equal(await exists(join(staged.path, ".agent-output")), false);
      assert.notEqual((await stat(generated)).ino, (await stat(copied)).ino);
      assert.equal(Object.isFrozen(staged), true);
      assert.equal(Object.isFrozen(staged.files), true);
      assert.equal(Object.isFrozen(staged.sha256), true);
      await assert.rejects(
        () => removeStagedAgentOutput({ ...staged }),
        /staging.*pertenece|controlador/i,
      );
      await removeStagedAgentOutput(staged);
      stagedRemoved = true;
      assert.equal(await exists(staged.path), false);
      assert.equal(await exists(stagingRoot), false);
      assert.equal(await exists(workspace.path), true);
      await removeAgentWorkspace(workspace);
      workspaceRemoved = true;
      assert.equal(await exists(workspace.path), false);
    } finally {
      if (!stagedRemoved) {
        await removeStagedAgentOutput(staged).catch(() => undefined);
      }
      if (!workspaceRemoved) {
        await removeAgentWorkspace(workspace).catch(() => undefined);
      }
    }
  });
});

test("rejects an oversized sparse agent output before reading it", async () => {
  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    try {
      await writeSparseFile(
        join(workspace.path, "src/pages/generated.astro"),
        8_388_609,
      );
      await assert.rejects(
        () =>
          validateAgentWorkspaceOutput(workspace, plan(repository.baseline)),
        /archivo.*l[ií]mite|excede.*archivo/i,
      );
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("rejects accepted output whose aggregate bytes exceed the fixed ceiling", async () => {
  await withWorkspaceRepository(async (repository) => {
    const generatedPlan = planWith(repository.baseline, {
      files: [
        {
          path: "public/generated/agent-isolation",
          operation: "create",
        },
      ],
    });
    const workspace = await createWorkspaceForPlan(repository, generatedPlan);
    try {
      for (const name of ["one.bin", "two.bin", "three.bin"]) {
        await writeSparseFile(
          join(workspace.path, "public/generated/agent-isolation", name),
          6_291_456,
        );
      }
      await assert.rejects(
        () => validateAgentWorkspaceOutput(workspace, generatedPlan),
        /salida.*bytes|bytes.*l[ií]mite|salida.*l[ií]mite/i,
      );
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("rejects accepted output whose file count exceeds the fixed ceiling", async () => {
  await withWorkspaceRepository(async (repository) => {
    const generatedPlan = planWith(repository.baseline, {
      files: [
        {
          path: "public/generated/agent-isolation",
          operation: "create",
        },
      ],
    });
    const workspace = await createWorkspaceForPlan(repository, generatedPlan);
    const outputRoot = join(workspace.path, "public/generated/agent-isolation");
    try {
      await mkdir(outputRoot, { recursive: true });
      for (let index = 0; index < 257; index += 1) {
        await writeFile(join(outputRoot, `${index}.txt`), "x", "utf8");
      }
      await assert.rejects(
        () => validateAgentWorkspaceOutput(workspace, generatedPlan),
        /cantidad.*archivo|archivos.*l[ií]mite/i,
      );
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("rejects workspace entries before directory inventory grows without bound", async () => {
  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    const hostileRoot = join(workspace.path, "hostile-directories");
    try {
      await mkdir(hostileRoot);
      for (let index = 0; index < 1_025; index += 1) {
        await mkdir(join(hostileRoot, `${index}`));
      }
      await assert.rejects(
        () => workspaceManifest(workspace),
        /cantidad.*entradas|inventario.*l[ií]mite/i,
      );
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

for (const hostile of [
  {
    name: "a symlink",
    setup: async (workspace: AgentWorkspace) => {
      const path = join(workspace.path, "src/pages/generated.astro");
      await mkdir(dirname(path), { recursive: true });
      await symlink("/tmp/outside", path);
    },
  },
  {
    name: "an unplanned file",
    setup: async (workspace: AgentWorkspace) => {
      await writeFile(join(workspace.path, "package.json"), "{}", "utf8");
    },
  },
  {
    name: "a hardlink",
    setup: async (workspace: AgentWorkspace) => {
      const path = join(workspace.path, "src/pages/generated.astro");
      await mkdir(dirname(path), { recursive: true });
      await link(join(workspace.path, "README.md"), path);
    },
  },
  {
    name: "a special file",
    setup: async (workspace: AgentWorkspace) => {
      const path = join(workspace.path, "src/pages/generated.astro");
      await mkdir(dirname(path), { recursive: true });
      await execFileAsync("mkfifo", [path]);
    },
  },
  {
    name: "a replaced private output directory",
    setup: async (workspace: AgentWorkspace) => {
      const output = join(workspace.path, ".agent-output");
      await rm(output, { recursive: true, force: false });
      await symlink("/tmp/outside", output);
    },
  },
]) {
  test(`rejects hostile workspace output containing ${hostile.name}`, async () => {
    await withWorkspaceRepository(async (repository) => {
      const workspace = await createAgentWorkspace(workspaceInput(repository));
      try {
        await hostile.setup(workspace);
        await assert.rejects(
          () =>
            validateAgentWorkspaceOutput(workspace, plan(repository.baseline)),
          /workspace|enlace|hardlink|especial|no aprobado/i,
        );
      } finally {
        await removeAgentWorkspace(workspace);
      }
    });
  });
}

test("rejects a directory created at a planned regular-file path", async () => {
  await withWorkspaceRepository(async (repository) => {
    await mkdir(join(repository.root, "src/pages"), { recursive: true });
    await writeFile(join(repository.root, "src/pages/.gitkeep"), "", "utf8");
    await git(repository.root, ["add", "src/pages/.gitkeep"]);
    await git(repository.root, ["commit", "--quiet", "-m", "page root"]);
    const currentRepository = {
      ...repository,
      baseline: await git(repository.root, ["rev-parse", "HEAD"]),
    };
    const approvedPlan = plan(currentRepository.baseline);
    const workspace = await createWorkspaceForPlan(
      currentRepository,
      approvedPlan,
    );
    try {
      await mkdir(join(workspace.path, "src/pages/generated.astro"));
      await assert.rejects(
        () => validateAgentWorkspaceOutput(workspace, approvedPlan),
        /directorio.*no aprobado|archivo regular/i,
      );
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("stages dependency manifests only when Gate 1 planned both and declared dependencies", async () => {
  await withWorkspaceRepository(async (repository) => {
    const dependencyPlan = planWith(repository.baseline, {
      dependencies: ["example@1.2.3"],
      files: [
        { path: "package.json", operation: "modify" },
        { path: "package-lock.json", operation: "modify" },
      ],
    });
    const workspace = await createWorkspaceForPlan(repository, dependencyPlan);
    try {
      await Promise.all([
        writeFile(
          join(workspace.path, "package.json"),
          '{"dependencies":{"example":"1.2.3"}}',
          "utf8",
        ),
        writeFile(
          join(workspace.path, "package-lock.json"),
          '{"lockfileVersion":3}',
          "utf8",
        ),
      ]);
      const staged = await validateAgentWorkspaceOutput(
        workspace,
        dependencyPlan,
      );
      try {
        assert.deepEqual(staged.files, ["package-lock.json", "package.json"]);
      } finally {
        await removeStagedAgentOutput(staged);
      }
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

for (const manifestCase of [
  {
    name: "no dependency declaration",
    changes: {
      dependencies: [],
      files: [
        { path: "package.json", operation: "modify" as const },
        { path: "package-lock.json", operation: "modify" as const },
      ],
    },
  },
  {
    name: "only one planned manifest",
    changes: {
      dependencies: ["example@1.2.3"],
      files: [{ path: "package.json", operation: "modify" as const }],
    },
  },
]) {
  test(`rejects dependency manifests with ${manifestCase.name}`, async () => {
    await withWorkspaceRepository(async (repository) => {
      const dependencyPlan = planWith(
        repository.baseline,
        manifestCase.changes,
      );
      const workspace = await createWorkspaceForPlan(
        repository,
        dependencyPlan,
      );
      try {
        await Promise.all([
          writeFile(join(workspace.path, "package.json"), "{}", "utf8"),
          writeFile(
            join(workspace.path, "package-lock.json"),
            '{"lockfileVersion":3}',
            "utf8",
          ),
        ]);
        await assert.rejects(
          () => validateAgentWorkspaceOutput(workspace, dependencyPlan),
          /package.*no aprobado|manifest/i,
        );
      } finally {
        await removeAgentWorkspace(workspace);
      }
    });
  });
}

test("stages safe descendants of explicitly planned generated roots", async () => {
  await withWorkspaceRepository(async (repository) => {
    const generatedPlan = planWith(repository.baseline, {
      files: [
        ...plan(repository.baseline).files,
        {
          path: "src/components/generated/agent-isolation",
          operation: "create",
        },
      ],
    });
    const workspace = await createWorkspaceForPlan(repository, generatedPlan);
    const component = join(
      workspace.path,
      "src/components/generated/agent-isolation/Card.astro",
    );
    try {
      await mkdir(dirname(component), { recursive: true });
      await writeFile(component, "<div />", "utf8");
      const staged = await validateAgentWorkspaceOutput(
        workspace,
        generatedPlan,
      );
      try {
        assert.deepEqual(staged.files, [
          "src/components/generated/agent-isolation/Card.astro",
        ]);
      } finally {
        await removeStagedAgentOutput(staged);
      }
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("rejects traversal in a planned output path", async () => {
  await withWorkspaceRepository(async (repository) => {
    const traversalPlan = planWith(repository.baseline, {
      files: [{ path: "../escape.astro", operation: "create" }],
    });
    const workspace = await createWorkspaceForPlan(repository, traversalPlan);
    try {
      await assert.rejects(
        () => validateAgentWorkspaceOutput(workspace, traversalPlan),
        /path.*seguro|traversal/i,
      );
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("rechecks copied inputs and trusted repositories before staging handoff", async () => {
  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    const generated = join(workspace.path, "src/pages/generated.astro");
    try {
      await mkdir(dirname(generated), { recursive: true });
      await writeFile(generated, "<h1>generated</h1>", "utf8");
      await writeFile(
        join(repository.sourceRoot, "agent-mutation.txt"),
        "changed",
        "utf8",
      );
      await assert.rejects(
        () =>
          validateAgentWorkspaceOutput(workspace, plan(repository.baseline)),
        /repositorio.*cambi[oó]/i,
      );
      await rm(join(repository.sourceRoot, "agent-mutation.txt"));
      await chmod(dirname(workspace.requestPath), 0o700);
      await chmod(workspace.requestPath, 0o600);
      await writeFile(workspace.requestPath, '{"changed":true}', "utf8");
      await assert.rejects(
        () =>
          validateAgentWorkspaceOutput(workspace, plan(repository.baseline)),
        /entrada copiada/i,
      );
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("command fixture emits only schema-valid JSON on stdout", async () => {
  await withAgentWorkspace(async (workspace) => {
    const result = await new CommandAgent(
      { command: process.execPath, args: [fixtureAgent] },
      testIsolationBroker(workspace.path),
      workspace,
    ).run(agentInput(workspace));
    assert.deepEqual(result.generatedFiles, ["src/pages/generated.astro"]);
    assert.equal(
      result.stdout,
      '{"generatedFiles":["src/pages/generated.astro"]}',
    );
  });
});

test("Codex delegates to its broker and reads only a schema-valid workspace final message", async () => {
  await withWorkspaceRepository(async (repository) => {
    const executable = join(repository.sourceRoot, "codex-fixture");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const capability = await createCodexExecutableCapability(
      await realpath(executable),
    );
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    const calls: BrokerRunInput[] = [];
    const broker = createOperatorIsolationBroker(async (brokerInput) => {
      calls.push(brokerInput);
      const outputIndex = brokerInput.args.indexOf("--output-last-message");
      await writeFile(
        brokerInput.args[outputIndex + 1]!,
        '{"generatedFiles":[]}',
        "utf8",
      );
      return {
        exitCode: 0,
        stdout: '{"type":"result"}',
        stderr: "",
        timedOut: false,
      };
    });
    try {
      const result = await new CodexAgent(
        capability,
        broker,
        workspace,
        5_000,
      ).run(agentInput(workspace));
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.workspace, workspace.path);
      assert.equal(calls[0]?.timeoutMs, 5_000);
      assert.deepEqual(calls[0]?.env, {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
      });
      assert.deepEqual(result.generatedFiles, []);
      assert.equal(result.finalMessage, '{"generatedFiles":[]}');
      assert.equal(result.stdout, '{"type":"result"}');
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("Codex rejects a forged path-only input before broker delegation", async () => {
  await withWorkspaceRepository(async (repository) => {
    const executable = join(repository.sourceRoot, "codex-fixture");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const capability = await createCodexExecutableCapability(
      await realpath(executable),
    );
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    let calls = 0;
    const broker = createOperatorIsolationBroker(async () => {
      calls += 1;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      };
    });
    try {
      await assert.rejects(
        new CodexAgent(capability, broker, workspace).run({
          ...agentInput(workspace),
          requestPath: join(repository.sourceRoot, "forged-request.json"),
        }),
        /workspace aprobado|contexto.*workspace/i,
      );
      assert.equal(calls, 0);
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("Codex rejects a caller-controlled timeout before broker delegation", async () => {
  await withWorkspaceRepository(async (repository) => {
    const executable = join(repository.sourceRoot, "codex-fixture");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const capability = await createCodexExecutableCapability(
      await realpath(executable),
    );
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    let calls = 0;
    const broker = createOperatorIsolationBroker(async ({ args }) => {
      calls += 1;
      const output = args[args.indexOf("--output-last-message") + 1];
      await writeFile(output!, '{"generatedFiles":[]}', "utf8");
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      };
    });
    try {
      await assert.rejects(
        new CodexAgent(capability, broker, workspace, 5_000).run({
          ...agentInput(workspace),
          timeoutMs: 1,
        } as AgentRunInput & { timeoutMs: number }),
        /timeout.*caller|timeout.*contexto/i,
      );
      assert.equal(calls, 0);
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("agent constructors reject invalid trusted timeout configuration", async () => {
  await withWorkspaceRepository(async (repository) => {
    const executable = join(repository.sourceRoot, "codex-fixture");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const capability = await createCodexExecutableCapability(
      await realpath(executable),
    );
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    const broker = recordingBroker();
    try {
      for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY, 300_001]) {
        assert.throws(
          () => new CodexAgent(capability, broker, workspace, timeoutMs),
          /timeout.*positivo|timeout.*l[ií]mite/i,
        );
        assert.throws(
          () =>
            new CommandAgent(
              { command: process.execPath, args: [], timeoutMs },
              broker,
              workspace,
            ),
          /timeout.*positivo|timeout.*l[ií]mite/i,
        );
      }
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("Codex rejects oversized final messages and broker logs", async () => {
  await withWorkspaceRepository(async (repository) => {
    const executable = join(repository.sourceRoot, "codex-fixture");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const capability = await createCodexExecutableCapability(
      await realpath(executable),
    );
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    const input = agentInput(workspace);
    try {
      await assert.rejects(
        new CodexAgent(
          capability,
          createOperatorIsolationBroker(async ({ args }) => {
            const output = args[args.indexOf("--output-last-message") + 1];
            await writeSparseFile(output!, 65_537);
            return {
              exitCode: 0,
              stdout: "",
              stderr: "",
              timedOut: false,
            };
          }),
          workspace,
        ).run(input),
        /mensaje final.*l[ií]mite|excede.*mensaje final/i,
      );
      await rm(join(workspace.path, ".agent-output", "final-message.json"));
      await assert.rejects(
        new CodexAgent(
          capability,
          createOperatorIsolationBroker(async ({ args }) => {
            const output = args[args.indexOf("--output-last-message") + 1];
            await writeFile(output!, '{"generatedFiles":[]}', "utf8");
            return {
              exitCode: 0,
              stdout: "x".repeat(262_145),
              stderr: "",
              timedOut: false,
            };
          }),
          workspace,
        ).run(input),
        /stdout.*l[ií]mite|l[ií]mite.*stdout/i,
      );
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("command result rejects traversal rather than trusting agent stdout", async () => {
  await withAgentWorkspace(async (workspace) => {
    const broker = createOperatorIsolationBroker(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ generatedFiles: ["../escape.astro"] }),
      stderr: "",
      timedOut: false,
    }));
    await assert.rejects(
      new CommandAgent(
        { command: process.execPath, args: [] },
        broker,
        workspace,
      ).run(agentInput(workspace)),
      /(path generado no seguro|schema agent-result)/i,
    );
  });
});

test("command result protocol fails closed for malformed JSON results", async () => {
  await withAgentWorkspace(async (workspace) => {
    for (const stdout of [
      "not json",
      "null",
      "[]",
      JSON.stringify({}),
      JSON.stringify({ generatedFiles: [], extra: true }),
      JSON.stringify({ generatedFiles: ["a", "a"] }),
    ]) {
      await assert.rejects(
        new CommandAgent(
          { command: process.execPath, args: [] },
          createOperatorIsolationBroker(async () => ({
            exitCode: 0,
            stdout,
            stderr: "",
            timedOut: false,
          })),
          workspace,
        ).run(agentInput(workspace)),
        /(JSON válido|schema agent-result)/i,
      );
    }
  });
});

test("adapters reject a forged structural run input before broker delegation", async () => {
  await withAgentWorkspace(async (workspace) => {
    let calls = 0;
    const broker = createOperatorIsolationBroker(async () => {
      calls += 1;
      return {
        exitCode: 0,
        stdout: '{"generatedFiles":[]}',
        stderr: "",
        timedOut: false,
      };
    });
    await assert.rejects(
      new CommandAgent(
        { command: process.execPath, args: [] },
        broker,
        workspace,
      ).run({
        ...agentInput(workspace),
        workspace: "/tmp/nope",
      }),
      /workspace aprobado|contexto.*workspace/i,
    );
    assert.equal(calls, 0);
  });
});

test("operator Codex capability rejects replacement before executing", async () => {
  await withWorkspaceRepository(async (repository) => {
    const executable = join(repository.sourceRoot, "codex-fixture");
    const link = join(repository.sourceRoot, "codex-link");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const capability = await createCodexExecutableCapability(
      await realpath(executable),
    );
    await symlink(executable, link);
    await assert.rejects(
      createCodexExecutableCapability(link),
      /regular|enlace/i,
    );
    await writeFile(join(repository.sourceRoot, "not-executable"), "x", {
      mode: 0o644,
    });
    await assert.rejects(
      createCodexExecutableCapability(
        join(repository.sourceRoot, "not-executable"),
      ),
      /EACCES|permission/i,
    );
    await assert.rejects(
      createCodexExecutableCapability(repository.sourceRoot),
      /regular/i,
    );
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    await writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    let calls = 0;
    const broker = createOperatorIsolationBroker(async () => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });
    try {
      await assert.rejects(
        new CodexAgent(capability, broker, workspace).run(
          agentInput(workspace),
        ),
        /identidad.*cambi/i,
      );
      assert.equal(calls, 0);
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("Codex result protocol fails closed when final message is not JSON", async () => {
  await withWorkspaceRepository(async (repository) => {
    const executable = join(repository.sourceRoot, "codex-fixture");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const capability = await createCodexExecutableCapability(
      await realpath(executable),
    );
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    const input = agentInput(workspace);
    try {
      await assert.rejects(
        new CodexAgent(
          capability,
          createOperatorIsolationBroker(async ({ args }) => {
            const output = args[args.indexOf("--output-last-message") + 1];
            await writeFile(output!, "not json", "utf8");
            return {
              exitCode: 0,
              stdout: "",
              stderr: "",
              timedOut: false,
            };
          }),
          workspace,
        ).run(input),
        /JSON válido/i,
      );
      const target = join(workspace.path, "attacker-final.json");
      const finalMessage = join(
        workspace.path,
        ".agent-output",
        "final-message.json",
      );
      await writeFile(target, '{"generatedFiles":[]}', "utf8");
      await rm(finalMessage);
      await symlink(target, finalMessage);
      await assert.rejects(
        new CodexAgent(
          capability,
          createOperatorIsolationBroker(async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
          })),
          workspace,
        ).run(input),
        /regular|enlace/i,
      );
      await rm(finalMessage);
      const outputDirectory = join(workspace.path, ".agent-output");
      const replacedOutput = join(workspace.path, "attacker-output");
      await assert.rejects(
        new CodexAgent(
          capability,
          createOperatorIsolationBroker(async () => {
            await rm(outputDirectory, { recursive: true, force: false });
            await mkdir(replacedOutput);
            await writeFile(
              join(replacedOutput, "final-message.json"),
              '{"generatedFiles":[]}',
              "utf8",
            );
            await symlink(replacedOutput, outputDirectory);
            return {
              exitCode: 0,
              stdout: "",
              stderr: "",
              timedOut: false,
            };
          }),
          workspace,
        ).run(input),
        /salida.*directorio seguro/i,
      );
    } finally {
      await rm(join(workspace.path, ".agent-output"), {
        recursive: true,
        force: true,
      });
      await mkdir(join(workspace.path, ".agent-output"));
      await removeAgentWorkspace(workspace);
    }
  });
});

test("fixture agents are bound to one owned disposable workspace", async () => {
  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    const run = await createFixtureAgentRun(workspace, async () => ({
      exitCode: 0,
      generatedFiles: [],
      stdout: "",
      stderr: "",
      finalMessage: '{"generatedFiles":[]}',
    }));
    const input = agentInput(workspace);
    try {
      assert.equal((await run.agent.run(input)).adapter, "fixture");
      await run.dispose();
      assert.equal(await exists(workspace.path), true);
      await assert.rejects(run.agent.run(input), /capacidad FixtureAgent/i);
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});

test("fixture disposal waits for an active leased handler", async () => {
  await withWorkspaceRepository(async (repository) => {
    const workspace = await createAgentWorkspace(workspaceInput(repository));
    let entered!: () => void;
    let release!: () => void;
    const enteredRun = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const run = await createFixtureAgentRun(workspace, async () => {
      entered();
      await released;
      return {
        exitCode: 0,
        generatedFiles: [],
        stdout: "",
        stderr: "",
        finalMessage: '{"generatedFiles":[]}',
      };
    });
    const input = agentInput(workspace);
    try {
      const active = run.agent.run(input);
      await enteredRun;
      let disposed = false;
      const disposing = run.dispose().then(() => (disposed = true));
      await Promise.resolve();
      assert.equal(disposed, false);
      release();
      await active;
      await disposing;
      assert.equal(await exists(workspace.path), true);
      await assert.rejects(run.agent.run(input), /capacidad FixtureAgent/i);
    } finally {
      await removeAgentWorkspace(workspace);
    }
  });
});
