import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  ProcessRunOptions,
  ProcessRunner,
} from "../../src/ingest/agents/types.ts";
import {
  assertTrustedRepositoriesUnchanged,
  assertWorkspaceInputs,
  createAgentWorkspace,
  removeAgentWorkspace,
  workspaceInputs,
  workspaceManifest,
  type AgentWorkspaceInput,
} from "../../src/ingest/workspaces/service.ts";
import {
  createCandidateWorktree,
  createAgentRunContext,
  createTestAgentRunContext,
  gitSnapshot,
  removeCandidateWorktree,
  setWorktreeTestHooks,
} from "../../src/ingest/worktrees/service.ts";
import { validateWorktreeDiff } from "../../src/ingest/worktrees/policy.ts";

const execFileAsync = promisify(execFile);
const hash = (character: string) => character.repeat(64);
const fixtureAgent = join(
  process.cwd(),
  "tests",
  "fixtures",
  "ingestion",
  "command-agent.mjs",
);
let fixtureBaseline = "";

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

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function withRepository(
  run: (context: { root: string; baseline: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-agents-"));
  try {
    await execFileAsync("git", [
      "init",
      "--quiet",
      "--initial-branch=main",
      root,
    ]);
    await git(root, ["config", "user.email", "fixture@example.test"]);
    await git(root, ["config", "user.name", "Fixture Human"]);
    await writeFile(join(root, "README.md"), "fixture\\n", "utf8");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "--quiet", "-m", "baseline"]);
    fixtureBaseline = await git(root, ["rev-parse", "HEAD"]);
    await run({ root, baseline: fixtureBaseline });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

async function createInput(
  root: string,
  candidatePath: string,
): Promise<AgentRunInput> {
  const requestPath = join(root, "request.json");
  const planPath = join(root, "plan.json");
  const policyPath = join(root, "policy.json");
  const resultSchemaPath = join(root, "agent-result.schema.json");
  const outputDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "comunidadsolar-agent-output-")),
  );
  await Promise.all([
    writeFile(requestPath, '{"intent":"untrusted instructions"}', "utf8"),
    writeFile(planPath, "{}", "utf8"),
    writeFile(policyPath, "{}", "utf8"),
    writeFile(resultSchemaPath, "{}", "utf8"),
  ]);
  return createTestAgentRunContext({
    changeId: "agent-isolation",
    attemptId: "attempt-000001",
    worktree: candidatePath,
    workspace: candidatePath,
    requestPath,
    planPath,
    policyPath,
    resultSchemaPath,
    timeoutMs: 5_000,
    outputDirectory,
  });
}

function recordingRunner(): {
  runner: ProcessRunner;
  calls: Array<{ command: string; args: string[]; options: ProcessRunOptions }>;
} {
  const calls: Array<{
    command: string;
    args: string[];
    options: ProcessRunOptions;
  }> = [];
  return {
    calls,
    runner: async (command, args, options) => {
      calls.push({
        command,
        args,
        options,
      });
      return { exitCode: 0, stdout: '{"generatedFiles":[]}', stderr: "" };
    },
  };
}

function recordingBroker(): IsolationBroker {
  return createOperatorIsolationBroker(async () => ({
    exitCode: 0,
    stdout: '{"generatedFiles":[]}',
    stderr: "",
    timedOut: false,
  }));
}

test("Codex runs ephemeral in workspace-write without bypass flags", () => {
  const invocation = codexInvocation({
    changeId: "agent-isolation",
    attemptId: "attempt-000001",
    worktree: "/safe/worktree",
    requestPath: "/safe/worktree/.agent-input/request.json",
    planPath: "/safe/worktree/.agent-input/plan.json",
    policyPath: "/safe/worktree/.agent-input/policy.json",
    resultSchemaPath: "/safe/schema.json",
    outputDirectory: "/safe/output",
  });
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
  assert.ok(!invocation.args.some((arg) => arg.includes("dangerously-bypass")));
});

test("command adapter delegates one complete argv-only job to the broker", async () => {
  const calls: BrokerRunInput[] = [];
  const commandWorkspace = await mkdtemp(
    join(tmpdir(), "comunidadsolar-command-broker-"),
  );
  const input = await createInput(commandWorkspace, commandWorkspace);
  const workspace = { path: commandWorkspace };
  const broker = createOperatorIsolationBroker(async (brokerInput) => {
    calls.push(brokerInput);
    return {
      exitCode: 0,
      stdout: '{"generatedFiles":[]}',
      stderr: "",
      timedOut: false,
    };
  });
  try {
    await new CommandAgent(
      { command: process.execPath, args: [fixtureAgent] },
      broker,
    ).run(input);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.workspace, workspace.path);
    assert.deepEqual(calls[0]?.env, {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
    });
    assert.equal(calls[0]?.args.includes("--shell"), false);
    assert.equal(calls[0]?.timeoutMs, 5_000);
  } finally {
    await rm(dirname(input.requestPath), { recursive: true, force: true });
    await rm(input.outputDirectory!, { recursive: true, force: true });
  }
});

test("production command adapter rejects no broker and a structural broker", async () => {
  const config = { command: process.execPath, args: [fixtureAgent] };
  const result = {
    exitCode: 0,
    stdout: '{"generatedFiles":[]}',
    stderr: "",
    timedOut: false,
  };
  const input = {
    changeId: "agent-isolation",
    attemptId: "attempt-000001",
    worktree: "/safe/worktree",
    workspace: "/safe/worktree",
    requestPath: "/safe/request.json",
    planPath: "/safe/plan.json",
    policyPath: "/safe/policy.json",
    resultSchemaPath: "/safe/schema.json",
    outputDirectory: "/safe/output",
  };
  await assert.rejects(
    () => new CommandAgent(config, null).run(input),
    /broker/i,
  );
  await assert.rejects(
    () =>
      new CommandAgent(config, {
        run: async () => result,
      } as never).run(input),
    /broker/i,
  );
});

test("broker timeout and non-zero exit never produce generated files", async () => {
  const workspace = await mkdtemp(
    join(tmpdir(), "comunidadsolar-command-timeout-"),
  );
  const input = await createInput(workspace, workspace);
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
  try {
    await assert.rejects(
      () => new CommandAgent(config, timedOut).run(input),
      /timeout/i,
    );
    await assert.rejects(
      () => new CommandAgent(config, nonZero).run(input),
      /código de salida/i,
    );
  } finally {
    await rm(dirname(input.requestPath), { recursive: true, force: true });
    await rm(input.outputDirectory!, { recursive: true, force: true });
  }
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
  await assert.rejects(
    new CommandAgent(
      { command: process.execPath, args: [fixtureAgent] },
      null,
    ).run({
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      worktree: "/safe/worktree",
      requestPath: "/safe/request.json",
      planPath: "/safe/plan.json",
      policyPath: "/safe/policy.json",
      resultSchemaPath: "/safe/schema.json",
      outputDirectory: "/safe/output",
    }),
    /isolation broker/i,
  );
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

test("candidate worktree copies immutable inputs and cleans only its exact path", async () => {
  await withRepository(async ({ root, baseline }) => {
    const requestPath = join(root, "request.json");
    const planPath = join(root, "plan.json");
    const policyPath = join(root, "policy.json");
    await Promise.all([
      writeFile(requestPath, JSON.stringify(request()), "utf8"),
      writeFile(planPath, JSON.stringify(plan(baseline)), "utf8"),
      writeFile(policyPath, "{}", "utf8"),
    ]);
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath,
      planPath,
      policyPath,
    });
    const sidecar = candidate.outputDirectory;
    try {
      assert.equal(await git(candidate.path, ["rev-parse", "HEAD"]), baseline);
      assert.equal(
        await git(candidate.path, ["branch", "--show-current"]),
        "candidate/agent-isolation/attempt-000001",
      );
      assert.equal(
        await readFile(
          join(candidate.path, ".agent-input", "request.json"),
          "utf8",
        ),
        JSON.stringify(request()),
      );
    } finally {
      await removeCandidateWorktree(candidate);
    }
    await assert.rejects(stat(candidate.path));
    await assert.rejects(stat(sidecar));
  });
});

test("candidate ref reservation preserves collisions and permits a released retry", async () => {
  await withRepository(async ({ root, baseline }) => {
    const branch = "candidate/agent-isolation/attempt-000001";
    await git(root, ["branch", branch, baseline]);
    const input = {
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    };
    await assert.rejects(createCandidateWorktree(input));
    assert.equal(await git(root, ["rev-parse", branch]), baseline);
    await git(root, ["branch", "-D", branch]);
    const first = await createCandidateWorktree(input);
    await removeCandidateWorktree(first);
    const retry = await createCandidateWorktree(input);
    await removeCandidateWorktree(retry);
    await assert.rejects(git(root, ["rev-parse", branch]));
  });
});

test("post-registration setup failure reconciles the reserved worktree and ref", async () => {
  await withRepository(async ({ root, baseline }) => {
    const input = {
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    };
    const restore = setWorktreeTestHooks({
      afterRegistration: () => {
        throw new Error("injected sidecar setup failure");
      },
    });
    try {
      await assert.rejects(createCandidateWorktree(input), /injected sidecar/i);
    } finally {
      restore();
    }
    await assert.rejects(
      stat(join(root, ".agent-worktrees", "agent-isolation", "attempt-000001")),
    );
    await assert.rejects(
      git(root, ["rev-parse", "candidate/agent-isolation/attempt-000001"]),
    );
    const retry = await createCandidateWorktree(input);
    await removeCandidateWorktree(retry);
  });
});

test("setup status drift is rejected and candidate state is reconciled", async () => {
  await withRepository(async ({ root, baseline }) => {
    const restore = setWorktreeTestHooks({
      beforeSetupSnapshot: async () => {
        await writeFile(join(root, "setup-drift.txt"), "drift", "utf8");
      },
    });
    try {
      await assert.rejects(
        createCandidateWorktree({
          repositoryRoot: root,
          approvedPlan: plan(baseline),
          changeId: "agent-isolation",
          attemptId: "attempt-000001",
          baselineCommit: baseline,
          requestPath: await writeInput(root, "request.json"),
          planPath: await writeInput(root, "plan.json"),
          policyPath: await writeInput(root, "policy.json"),
        }),
        /refs protegidas|creación/i,
      );
    } finally {
      restore();
    }
    assert.equal(
      await readFile(join(root, "setup-drift.txt"), "utf8"),
      "drift",
    );
    await assert.rejects(
      git(root, ["rev-parse", "candidate/agent-isolation/attempt-000001"]),
    );
  });
});

test("candidate Git authority rejects a replaced gitfile before candidate snapshots", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    let candidateSnapshotReached = false;
    const restore = setWorktreeTestHooks({
      beforeGitSnapshotStatus: (path) => {
        if (path === candidate.path) candidateSnapshotReached = true;
      },
    });
    try {
      await writeFile(
        join(candidate.path, ".git"),
        `gitdir: ${join(root, ".git")}\n`,
        "utf8",
      );
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /autoridad Git|gitdir candidato/i,
      );
      assert.equal(candidateSnapshotReached, false);
    } finally {
      restore();
      await removeCandidateWorktree(candidate).catch(() => undefined);
    }
  });
});

test("candidate Git authority rejects a substituted leaf with a hardlinked original gitfile", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    const displaced = join(root, "displaced-candidate");
    let candidateGitStarted = false;
    const restore = setWorktreeTestHooks({
      beforeGitSnapshotStatus: (path) => {
        if (path === candidate.path) candidateGitStarted = true;
      },
    });
    try {
      await rename(candidate.path, displaced);
      await mkdir(candidate.path);
      await link(join(displaced, ".git"), join(candidate.path, ".git"));
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /identidad física|identidad del worktree/i,
      );
      assert.equal(candidateGitStarted, false);
    } finally {
      restore();
      await rm(candidate.path, { recursive: true, force: true });
    }
  });
});

test("snapshot rejects a protected ref move between refs and status", async () => {
  await withRepository(async ({ root, baseline }) => {
    const alternate = await git(root, [
      "commit-tree",
      `${baseline}^{tree}`,
      "-p",
      baseline,
      "-m",
      "mid-snapshot",
    ]);
    let moved = false;
    const restore = setWorktreeTestHooks({
      beforeGitSnapshotStatus: async (path) => {
        if (!moved && path === root) {
          moved = true;
          await git(root, [
            "update-ref",
            "refs/heads/main",
            alternate,
            baseline,
          ]);
        }
      },
    });
    try {
      await assert.rejects(gitSnapshot(root), /estado Git.*snapshot/i);
      assert.equal(moved, true);
    } finally {
      restore();
    }
  });
});

test("sequential candidate validation rejects ref movement while another authority is read", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    let moved = false;
    const restore = setWorktreeTestHooks({
      afterCandidateValidationSnapshot: async (kind) => {
        if (!moved && kind === "repository") {
          moved = true;
          await git(root, [
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "between-authorities",
          ]);
        }
      },
    });
    try {
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /snapshots Git protegidos|ref protegido/i,
      );
      assert.equal(moved, true);
    } finally {
      restore();
      await removeCandidateWorktree(candidate).catch(() => undefined);
    }
  });
});

test("candidate cleanup quarantines a replacement before pruning Git registration", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    let quarantined = "";
    const restore = setWorktreeTestHooks({
      afterCandidateQuarantine: async (path) => {
        quarantined = path;
        await rm(path, { recursive: true, force: false });
        await mkdir(path);
        await writeFile(join(path, "external.txt"), "preserve", "utf8");
      },
    });
    try {
      await assert.rejects(removeCandidateWorktree(candidate), /cuarentena/i);
      assert.equal(
        await readFile(join(quarantined, "external.txt"), "utf8"),
        "preserve",
      );
      assert.ok(
        (await git(root, ["worktree", "list", "--porcelain"])).includes(
          `worktree ${candidate.path}`,
        ),
      );
    } finally {
      restore();
      if (quarantined) await rm(quarantined, { recursive: true, force: true });
    }
  });
});

test("service Git runner does not execute a shared reference-transaction hook", async () => {
  await withRepository(async ({ root, baseline }) => {
    const hooks = join(root, "malicious-hooks");
    const marker = join(root, "hook-ran");
    await mkdir(hooks);
    await writeFile(
      join(hooks, "reference-transaction"),
      `#!/bin/sh\necho invoked > '${marker}'\n`,
      { mode: 0o755 },
    );
    await chmod(join(hooks, "reference-transaction"), 0o755);
    await git(root, ["config", "core.hooksPath", hooks]);
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    try {
      await assert.rejects(stat(marker));
    } finally {
      await removeCandidateWorktree(candidate).catch(() => undefined);
    }
  });
});

test("validation rejects drift after the final candidate snapshot", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    let moved = false;
    const alternate = await git(root, [
      "commit-tree",
      `${baseline}^{tree}`,
      "-p",
      baseline,
      "-m",
      "late-drift",
    ]);
    const restore = setWorktreeTestHooks({
      afterFinalCandidateSnapshot: async () => {
        moved = true;
        await git(root, ["update-ref", "refs/heads/main", alternate, baseline]);
      },
    } as never);
    try {
      await assert.rejects(validateWorktreeDiff(candidate, plan(baseline)));
      assert.equal(moved, true);
    } finally {
      restore();
      await removeCandidateWorktree(candidate).catch(() => undefined);
    }
  });
});

test("cleanup rechecks quarantine identity after its first verification", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    let quarantined = "";
    const restore = setWorktreeTestHooks({
      afterCandidateQuarantineVerified: async (path: string) => {
        quarantined = path;
        await rm(path, { recursive: true, force: false });
        await mkdir(path);
        await writeFile(join(path, "external.txt"), "preserve", "utf8");
      },
    } as never);
    try {
      await assert.rejects(removeCandidateWorktree(candidate), /cuarentena/i);
      assert.equal(
        await readFile(join(quarantined, "external.txt"), "utf8"),
        "preserve",
      );
    } finally {
      restore();
      if (quarantined) await rm(quarantined, { recursive: true, force: true });
    }
  });
});

test("setup rejects unowned worktree-root contents instead of filtering their prefix", async () => {
  await withRepository(async ({ root, baseline }) => {
    const evil = join(root, ".agent-worktrees", "evil", "marker");
    const restore = setWorktreeTestHooks({
      beforeSetupSnapshot: async () => {
        await mkdir(dirname(evil), { recursive: true });
        await writeFile(evil, "external", "utf8");
      },
    });
    try {
      await assert.rejects(
        createCandidateWorktree({
          repositoryRoot: root,
          approvedPlan: plan(baseline),
          changeId: "agent-isolation",
          attemptId: "attempt-000001",
          baselineCommit: baseline,
          requestPath: await writeInput(root, "request.json"),
          planPath: await writeInput(root, "plan.json"),
          policyPath: await writeInput(root, "policy.json"),
        }),
        /refs protegidas|creación/i,
      );
    } finally {
      restore();
    }
    assert.equal(await readFile(evil, "utf8"), "external");
  });
});

test("collapsed ignored worktree marker still exposes an evil sibling through the leaf manifest", async () => {
  await withRepository(async ({ root, baseline }) => {
    await writeFile(
      join(root, ".git", "info", "exclude"),
      ".agent-worktrees/\n",
    );
    const evil = join(root, ".agent-worktrees", "evil", "marker");
    const restore = setWorktreeTestHooks({
      beforeSetupSnapshot: async () => {
        await mkdir(dirname(evil), { recursive: true });
        await writeFile(evil, "external", "utf8");
      },
    });
    try {
      await assert.rejects(
        createCandidateWorktree({
          repositoryRoot: root,
          approvedPlan: plan(baseline),
          changeId: "agent-isolation",
          attemptId: "attempt-000001",
          baselineCommit: baseline,
          requestPath: await writeInput(root, "request.json"),
          planPath: await writeInput(root, "plan.json"),
          policyPath: await writeInput(root, "policy.json"),
        }),
        /refs protegidas|creación/i,
      );
    } finally {
      restore();
    }
    assert.equal(await readFile(evil, "utf8"), "external");
  });
});

test("setup rejects an unowned ignored empty service directory", async () => {
  await withRepository(async ({ root, baseline }) => {
    await writeFile(
      join(root, ".git", "info", "exclude"),
      ".agent-worktrees/\n",
    );
    const evil = join(root, ".agent-worktrees", "evil");
    const restore = setWorktreeTestHooks({
      beforeSetupSnapshot: async () => {
        await mkdir(evil, { recursive: true });
      },
    });
    try {
      await assert.rejects(
        createCandidateWorktree({
          repositoryRoot: root,
          approvedPlan: plan(baseline),
          changeId: "agent-isolation",
          attemptId: "attempt-000001",
          baselineCommit: baseline,
          requestPath: await writeInput(root, "request.json"),
          planPath: await writeInput(root, "plan.json"),
          policyPath: await writeInput(root, "policy.json"),
        }),
        /refs protegidas|creación/i,
      );
    } finally {
      restore();
    }
    assert.equal((await lstat(evil)).isDirectory(), true);
  });
});

test("validation rejects an unowned ignored empty service directory after setup", async () => {
  await withRepository(async ({ root, baseline }) => {
    await writeFile(
      join(root, ".git", "info", "exclude"),
      ".agent-worktrees/\n",
    );
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    try {
      await mkdir(join(root, ".agent-worktrees", "evil"));
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /manifiesto de servicio|repositorio principal/i,
      );
    } finally {
      await removeCandidateWorktree(candidate);
    }
  });
});

test("service manifest rejects a directory swapped to a symlink during enumeration", async () => {
  await withRepository(async ({ root, baseline }) => {
    const evil = join(root, ".agent-worktrees", "evil");
    const outside = await mkdtemp(
      join(tmpdir(), "comunidadsolar-manifest-outside-"),
    );
    await mkdir(evil, { recursive: true });
    const canonicalEvil = await realpath(evil);
    let swapped = false;
    const restore = setWorktreeTestHooks({
      beforeServiceDirectoryRead: async (path) => {
        if (path !== canonicalEvil || swapped) return;
        swapped = true;
        await rm(path, { recursive: true, force: false });
        await symlink(outside, path);
      },
    });
    try {
      await assert.rejects(
        createCandidateWorktree({
          repositoryRoot: root,
          approvedPlan: plan(baseline),
          changeId: "agent-isolation",
          attemptId: "attempt-000001",
          baselineCommit: baseline,
          requestPath: await writeInput(root, "request.json"),
          planPath: await writeInput(root, "plan.json"),
          policyPath: await writeInput(root, "policy.json"),
        }),
        /identidad del directorio (de servicio|del scanner)/i,
      );
    } finally {
      restore();
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("service manifest rejects an empty directory swapped after enumeration", async () => {
  await withRepository(async ({ root, baseline }) => {
    await writeFile(
      join(root, ".git", "info", "exclude"),
      ".agent-worktrees/\n",
    );
    const evil = join(root, ".agent-worktrees", "evil");
    const outside = await mkdtemp(
      join(tmpdir(), "comunidadsolar-manifest-outside-"),
    );
    await mkdir(evil, { recursive: true });
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    const canonicalEvil = await realpath(evil);
    let reads = 0;
    const restore = setWorktreeTestHooks({
      afterServiceDirectoryRead: async (path) => {
        if (path !== canonicalEvil || ++reads !== 1) return;
        await rm(path, { recursive: true, force: false });
        await symlink(outside, path);
      },
    });
    try {
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /identidad del directorio (de servicio|del scanner)/i,
      );
    } finally {
      restore();
      await removeCandidateWorktree(candidate).catch(() => undefined);
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("service manifest rejects a parent swapped before child traversal", async () => {
  await withRepository(async ({ root, baseline }) => {
    await writeFile(
      join(root, ".git", "info", "exclude"),
      ".agent-worktrees/\n",
    );
    const evil = join(root, ".agent-worktrees", "evil");
    const marker = join(evil, "marker");
    const outside = await mkdtemp(
      join(tmpdir(), "comunidadsolar-manifest-outside-"),
    );
    await mkdir(evil, { recursive: true });
    await writeFile(marker, "same inode", "utf8");
    await link(marker, join(outside, "marker"));
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    const canonicalEvil = await realpath(evil);
    let reads = 0;
    const restore = setWorktreeTestHooks({
      afterServiceDirectoryRead: async (path) => {
        if (path !== canonicalEvil || ++reads !== 1) return;
        await rm(path, { recursive: true, force: false });
        await symlink(outside, path);
      },
    });
    try {
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /(identidad del directorio (de servicio|del scanner)|enumeración del directorio de servicio)/i,
      );
    } finally {
      restore();
      await removeCandidateWorktree(candidate).catch(() => undefined);
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("service manifest commits ignored regular-file content", async () => {
  await withRepository(async ({ root, baseline }) => {
    await writeFile(
      join(root, ".git", "info", "exclude"),
      ".agent-worktrees/\n",
    );
    const marker = join(root, ".agent-worktrees", "evil", "marker");
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, "before", "utf8");
    const original = await lstat(marker);
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    try {
      await writeFile(marker, "after!", "utf8");
      const changed = await lstat(marker);
      assert.equal(changed.dev, original.dev);
      assert.equal(changed.ino, original.ino);
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /manifiesto de servicio|repositorio principal/i,
      );
    } finally {
      await removeCandidateWorktree(candidate).catch(() => undefined);
    }
  });
});

test("service manifest rejects a child added after directory enumeration", async () => {
  await withRepository(async ({ root, baseline }) => {
    await writeFile(
      join(root, ".git", "info", "exclude"),
      ".agent-worktrees/\n",
    );
    const evil = join(root, ".agent-worktrees", "evil");
    await mkdir(evil, { recursive: true });
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    const canonicalEvil = await realpath(evil);
    const scannerRoot = await realpath(root);
    let reads = 0;
    const restore = setWorktreeTestHooks({
      afterServiceDirectoryRead: async (path) => {
        if (path !== canonicalEvil || ++reads !== 1) return;
        await writeFile(join(path, "late-marker"), "late", "utf8");
      },
      afterServiceDirectoryEntry: async (path) => {
        if (path !== canonicalEvil || reads !== 1) return;
        await rm(join(path, "late-marker"), { force: false });
      },
    });
    try {
      await assert.rejects(
        gitSnapshot(scannerRoot, [candidate.path]),
        /identidad|enumeración del directorio de servicio/i,
      );
    } finally {
      restore();
      await removeCandidateWorktree(candidate).catch(() => undefined);
    }
  });
});

test("service manifest rejects a service root created after its sibling traversal", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    const scannerRoot = await realpath(root);
    const worktrees = join(scannerRoot, ".agent-worktrees");
    let created = false;
    const restore = setWorktreeTestHooks({
      afterServiceDirectoryEntry: async (path) => {
        if (path !== worktrees || created) return;
        created = true;
        await mkdir(join(scannerRoot, ".agent-quarantine", "evil"), {
          recursive: true,
        });
      },
    });
    try {
      await assert.rejects(
        gitSnapshot(scannerRoot, [candidate.path]),
        /enumeración del directorio de servicio/i,
      );
    } finally {
      restore();
      await removeCandidateWorktree(candidate).catch(() => undefined);
    }
  });
});

test("service manifest rejects a nested service entry created after traversal", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    const scannerRoot = await realpath(root);
    const worktrees = join(scannerRoot, ".agent-worktrees");
    let created = false;
    const restore = setWorktreeTestHooks({
      afterServiceDirectoryEntry: async (path) => {
        if (path !== worktrees || created) return;
        created = true;
        await mkdir(join(worktrees, "evil"), { recursive: true });
      },
    });
    try {
      await assert.rejects(
        gitSnapshot(scannerRoot, [candidate.path]),
        /manifiesto de servicio|enumeración del directorio de servicio/i,
      );
    } finally {
      restore();
      await removeCandidateWorktree(candidate).catch(() => undefined);
    }
  });
});

test("service manifest rejects a leaf changed after its first digest", async () => {
  await withRepository(async ({ root, baseline }) => {
    await writeFile(
      join(root, ".git", "info", "exclude"),
      ".agent-worktrees/\n",
    );
    const marker = join(root, ".agent-worktrees", "evil", "marker");
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, "before", "utf8");
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    const canonicalEvil = await realpath(dirname(marker));
    let changed = false;
    const restore = setWorktreeTestHooks({
      afterServiceChildTraversal: async (parent, child) => {
        if (parent !== canonicalEvil || child !== "marker" || changed) return;
        changed = true;
        await writeFile(marker, "after", "utf8");
      },
    });
    try {
      await assert.rejects(
        gitSnapshot(await realpath(root), [candidate.path]),
        /manifiesto de servicio|enumeración del directorio de servicio/i,
      );
    } finally {
      restore();
      await removeCandidateWorktree(candidate).catch(() => undefined);
    }
  });
});

test("service manifest commits directory mode across complete captures", async () => {
  await withRepository(async ({ root, baseline }) => {
    await writeFile(
      join(root, ".git", "info", "exclude"),
      ".agent-worktrees/\n",
    );
    const evil = join(root, ".agent-worktrees", "evil");
    await mkdir(evil, { recursive: true });
    await chmod(evil, 0o755);
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    const worktrees = join(await realpath(root), ".agent-worktrees");
    let changed = false;
    const restore = setWorktreeTestHooks({
      afterServiceDirectoryEntry: async (path) => {
        if (path !== worktrees || changed) return;
        changed = true;
        await chmod(evil, 0o700);
      },
    });
    try {
      await assert.rejects(
        gitSnapshot(await realpath(root), [candidate.path]),
        /manifiesto de servicio|enumeración del directorio de servicio/i,
      );
    } finally {
      restore();
      await removeCandidateWorktree(candidate).catch(() => undefined);
    }
  });
});

test("validation rechecks refs moved during service capture", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    const worktrees = join(await realpath(root), ".agent-worktrees");
    let moved = false;
    const restore = setWorktreeTestHooks({
      afterServiceDirectoryEntry: async (path) => {
        if (path !== worktrees || moved) return;
        moved = true;
        await git(root, [
          "commit",
          "--allow-empty",
          "--quiet",
          "-m",
          "move main during snapshot",
        ]);
      },
    });
    try {
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /ref protegido|repositorio principal|enumeración del directorio de servicio/i,
      );
    } finally {
      restore();
      await removeCandidateWorktree(candidate).catch(() => undefined);
    }
  });
});

test("service manifest anchors child traversal across a transient parent swap", async () => {
  await withRepository(async ({ root, baseline }) => {
    await writeFile(
      join(root, ".git", "info", "exclude"),
      ".agent-worktrees/\n",
    );
    const evil = join(root, ".agent-worktrees", "evil");
    const marker = join(evil, "marker");
    const held = join(root, "held-evil");
    const outside = await mkdtemp(
      join(tmpdir(), "comunidadsolar-manifest-outside-"),
    );
    await mkdir(evil, { recursive: true });
    await writeFile(marker, "inside", "utf8");
    await writeFile(join(outside, "marker"), "outside", "utf8");
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    const canonicalEvil = await realpath(evil);
    const scannerRoot = await realpath(root);
    let reads = 0;
    let swapped = false;
    const restore = setWorktreeTestHooks({
      afterServiceDirectoryRead: (path) => {
        if (path === canonicalEvil) reads += 1;
      },
      beforeServiceChildTraversal: async (parent, child) => {
        if (parent !== canonicalEvil || child !== "marker" || reads !== 1)
          return;
        await rename(parent, held);
        await symlink(outside, parent);
        swapped = true;
      },
      afterServiceChildTraversal: async (parent, child) => {
        if (!swapped || parent !== canonicalEvil || child !== "marker") return;
        await rm(parent, { recursive: true, force: false });
        await rename(held, parent);
      },
    });
    try {
      await assert.rejects(
        gitSnapshot(scannerRoot, [candidate.path]),
        /identidad del directorio (de servicio|del scanner)/i,
      );
    } finally {
      restore();
      await removeCandidateWorktree(candidate).catch(() => undefined);
      await rm(held, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("service manifest rejects a leaf changed transiently during descriptor read", async () => {
  await withRepository(async ({ root, baseline }) => {
    await writeFile(
      join(root, ".git", "info", "exclude"),
      ".agent-worktrees/\n",
    );
    const marker = join(root, ".agent-worktrees", "evil", "marker");
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, "before", "utf8");
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    const scannerRoot = await realpath(root);
    let reads = 0;
    const restore = setWorktreeTestHooks({
      afterServiceFileRead: async (path) => {
        if (!path.endsWith("/evil/marker") || ++reads !== 1) return;
        await writeFile(path, "middle", "utf8");
        await writeFile(path, "before", "utf8");
      },
    });
    try {
      await assert.rejects(
        gitSnapshot(scannerRoot, [candidate.path]),
        /identidad (del archivo|del directorio) de servicio/i,
      );
    } finally {
      restore();
      await removeCandidateWorktree(candidate).catch(() => undefined);
    }
  });
});

test("sidecar cleanup retains a replaced quarantined leaf", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    let moved = "";
    const restore = setWorktreeTestHooks({
      beforeSidecarDelete: async (path) => {
        moved = path;
        await rm(path, { recursive: true, force: false });
        await mkdir(path);
        await writeFile(join(path, "do-not-delete"), "external", "utf8");
      },
    });
    try {
      await assert.rejects(
        removeCandidateWorktree(candidate),
        /cuarentena de salida/i,
      );
      assert.equal(
        await readFile(join(moved, "do-not-delete"), "utf8"),
        "external",
      );
    } finally {
      restore();
      if (moved) await rm(dirname(moved), { recursive: true, force: true });
    }
  });
});

test("private snapshots and schema authority cannot be replaced through candidate input", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    try {
      assert.throws(() => {
        (
          candidate as unknown as { repositorySnapshot: { refs: string } }
        ).repositorySnapshot = { refs: "forged" };
      });
      const context = await (
        createAgentRunContext as unknown as (
          value: typeof candidate,
          ignored: string,
        ) => Promise<AgentRunInput>
      )(candidate, "/tmp/attacker-schema.json");
      assert.equal(
        context.resultSchemaPath,
        join(process.cwd(), "schemas", "ingestion", "agent-result.schema.json"),
      );
      await git(root, ["tag", "attacker-ref"]);
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /ref/i,
      );
    } finally {
      await removeCandidateWorktree(candidate);
    }
  });
});

test("rejects an agent change outside approved output paths", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    try {
      await writeFile(join(candidate.path, "package.json"), "{}", "utf8");
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /package\.json no aprobado/i,
      );
      await assert.rejects(stat(candidate.path));
    } finally {
      await removeCandidateWorktree(candidate);
    }
  });
});

test("rejects an agent-created commit or changed protected ref", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    try {
      await git(root, ["update-ref", "refs/heads/main", baseline]);
      await git(candidate.path, [
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "agent commit",
      ]);
      const agentCommit = await git(candidate.path, ["rev-parse", "HEAD"]);
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /commit creado por el agente/i,
      );
      assert.equal(
        await git(root, [
          "rev-parse",
          "candidate/agent-isolation/attempt-000001",
        ]),
        agentCommit,
      );
      await assert.rejects(stat(candidate.path));
    } finally {
      await assert.rejects(removeCandidateWorktree(candidate), /cuarentena/i);
    }
  });
});

test("rejects changed protected refs and mutated copied agent input", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    try {
      await git(root, [
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "moved main",
      ]);
      await writeFile(
        join(candidate.path, ".agent-input", "request.json"),
        "changed",
        "utf8",
      );
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /Git ref protegido|entrada del agente/i,
      );
    } finally {
      await removeCandidateWorktree(candidate);
    }
  });
});

test("refuses an existing or symlinked candidate target without deleting it", async () => {
  await withRepository(async ({ root, baseline }) => {
    const target = join(
      root,
      ".agent-worktrees",
      "agent-isolation",
      "attempt-000001",
    );
    await mkdir(target, { recursive: true });
    const marker = join(target, "do-not-delete");
    await writeFile(marker, "owned by somebody else", "utf8");
    await assert.rejects(
      createCandidateWorktree({
        repositoryRoot: root,
        approvedPlan: plan(baseline),
        changeId: "agent-isolation",
        attemptId: "attempt-000001",
        baselineCommit: baseline,
        requestPath: await writeInput(root, "request.json"),
        planPath: await writeInput(root, "plan.json"),
        policyPath: await writeInput(root, "policy.json"),
      }),
      /existente|ocupado/i,
    );
    assert.equal(await readFile(marker, "utf8"), "owned by somebody else");
  });
  await withRepository(async ({ root, baseline }) => {
    const outside = await mkdtemp(join(tmpdir(), "comunidadsolar-outside-"));
    try {
      await symlink(outside, join(root, ".agent-worktrees"));
      await assert.rejects(
        createCandidateWorktree({
          repositoryRoot: root,
          approvedPlan: plan(baseline),
          changeId: "agent-isolation",
          attemptId: "attempt-000001",
          baselineCommit: baseline,
          requestPath: await writeInput(root, "request.json"),
          planPath: await writeInput(root, "plan.json"),
          policyPath: await writeInput(root, "policy.json"),
        }),
        /enlace|seguro/i,
      );
      await assert.rejects(
        stat(join(outside, "agent-isolation", "attempt-000001")),
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("rejects substituted copied plan and request bindings before creating a candidate", async () => {
  await withRepository(async ({ root, baseline }) => {
    const approvedPlan = plan(baseline);
    const alternateUnsigned = {
      ...approvedPlan,
      targetPath: "/other" as const,
    };
    const { planSha256: ignoredPlanHash, ...alternateWithoutHash } =
      alternateUnsigned;
    void ignoredPlanHash;
    const alternatePlan = {
      ...alternateWithoutHash,
      planSha256: sha256Canonical(alternateWithoutHash),
    };
    const requestPath = await writeInput(root, "request.json");
    const planPath = await writeInput(root, "plan.json");
    const policyPath = await writeInput(root, "policy.json");
    await writeFile(planPath, JSON.stringify(alternatePlan), "utf8");
    await assert.rejects(
      createCandidateWorktree({
        repositoryRoot: root,
        changeId: "agent-isolation",
        attemptId: "attempt-000001",
        baselineCommit: baseline,
        approvedPlan,
        requestPath,
        planPath,
        policyPath,
      }),
      /plan aprobado|request/i,
    );
  });
});

test("rejects ref and sidecar mutation, while allowing only contained generated roots", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    try {
      await git(root, ["tag", "agent-created-tag"]);
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /ref/i,
      );
    } finally {
      await removeCandidateWorktree(candidate);
    }
  });
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    try {
      await mkdir(join(candidate.path, ".agent-output"), { recursive: true });
      await writeFile(join(candidate.path, ".agent-output", "escape"), "bad");
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /\.agent-output\/escape no aprobado/i,
      );
    } finally {
      await removeCandidateWorktree(candidate);
    }
  });
});

test("command result rejects traversal rather than trusting agent stdout", async () => {
  const worktree = await mkdtemp(
    join(tmpdir(), "comunidadsolar-command-result-"),
  );
  const input = await createInput(worktree, worktree);
  try {
    const broker = createOperatorIsolationBroker(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ generatedFiles: ["../escape.astro"] }),
      stderr: "",
      timedOut: false,
    }));
    await assert.rejects(
      new CommandAgent({ command: process.execPath, args: [] }, broker).run(
        input,
      ),
      /(path generado no seguro|schema agent-result)/i,
    );
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(input.outputDirectory!, { recursive: true, force: true });
  }
});

test("command result protocol fails closed for malformed JSON results", async () => {
  const worktree = await mkdtemp(
    join(tmpdir(), "comunidadsolar-command-malformed-"),
  );
  const input = await createInput(worktree, worktree);
  try {
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
        ).run(input),
        /(JSON válido|schema agent-result)/i,
      );
    }
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(input.outputDirectory!, { recursive: true, force: true });
  }
});

test("adapters reject a forged structural run input before broker delegation", async () => {
  await assert.rejects(
    new CommandAgent(
      { command: process.execPath, args: [] },
      recordingBroker(),
    ).run({
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      worktree: "/tmp/nope",
      requestPath: "/tmp/request",
      planPath: "/tmp/plan",
      policyPath: "/tmp/policy",
      resultSchemaPath: "/tmp/schema",
      outputDirectory: "/tmp/output",
    }),
    /contexto de ejecución/i,
  );
});

test("frozen candidate projection supplies immutable paths to the broker", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    try {
      const context = await createAgentRunContext(candidate);
      assert.throws(() => {
        (candidate as { outputDirectory: string }).outputDirectory =
          "/tmp/forged";
      });
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
        { command: process.execPath, args: [] },
        broker,
      ).run(context);
      assert.deepEqual(JSON.parse(calls[0]!.stdin), {
        requestPath: join(candidate.path, ".agent-input", "request.json"),
        planPath: join(candidate.path, ".agent-input", "plan.json"),
        policyPath: join(candidate.path, ".agent-input", "policy.json"),
        resultSchemaPath: join(
          process.cwd(),
          "schemas",
          "ingestion",
          "agent-result.schema.json",
        ),
      });
    } finally {
      await removeCandidateWorktree(candidate);
    }
  });
});

test("owned run context rejects a replaced sidecar before spawning", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    try {
      const context = await createAgentRunContext(candidate);
      await rm(candidate.outputDirectory, { recursive: true, force: false });
      await mkdir(candidate.outputDirectory);
      await assert.rejects(
        new CommandAgent(
          { command: process.execPath, args: [] },
          recordingBroker(),
        ).run(context),
        /salida.*cambi|identidad/i,
      );
    } finally {
      await assert.rejects(
        removeCandidateWorktree(candidate),
        /identidad de la salida/i,
      );
      await rm(candidate.outputDirectory, { recursive: true, force: true });
    }
  });
});

test("owned run context rejects a same-content copied input replacement", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    try {
      const context = await createAgentRunContext(candidate);
      const copiedRequest = join(
        candidate.path,
        ".agent-input",
        "request.json",
      );
      const content = await readFile(copiedRequest);
      await rm(copiedRequest);
      await writeFile(copiedRequest, content);
      await assert.rejects(
        new CommandAgent(
          { command: process.execPath, args: [] },
          recordingBroker(),
        ).run(context),
        /entrada.*cambi|identidad/i,
      );
    } finally {
      await removeCandidateWorktree(candidate);
    }
  });
});

test("operator Codex capability rejects replacement before executing", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "comunidadsolar-codex-capability-"),
  );
  const executable = join(root, "codex-fixture");
  const link = join(root, "codex-link");
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const capability = await createCodexExecutableCapability(
      await realpath(executable),
    );
    await symlink(executable, link);
    await assert.rejects(
      createCodexExecutableCapability(link),
      /regular|enlace/i,
    );
    await writeFile(join(root, "not-executable"), "x", { mode: 0o644 });
    await assert.rejects(
      createCodexExecutableCapability(join(root, "not-executable")),
      /EACCES|permission/i,
    );
    await assert.rejects(createCodexExecutableCapability(root), /regular/i);
    await writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const input = await createInput(root, root);
    const { runner, calls } = recordingRunner();
    await assert.rejects(
      new CodexAgent(capability, runner).run(input),
      /identidad.*cambi/i,
    );
    assert.equal(calls.length, 0);
    await rm(input.outputDirectory!, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex result protocol fails closed when final message is not JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-codex-result-"));
  const executable = join(root, "codex-fixture");
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const capability = await createCodexExecutableCapability(
      await realpath(executable),
    );
    const input = await createInput(root, root);
    await assert.rejects(
      new CodexAgent(capability, async (_command, args) => {
        const output = args[args.indexOf("--output-last-message") + 1];
        await writeFile(output!, "not json", "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      }).run(input),
      /JSON válido/i,
    );
    await rm(input.outputDirectory!, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture agents are bound to one owned disposable candidate", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    const run = await createFixtureAgentRun(candidate, async () => ({
      exitCode: 0,
      generatedFiles: [],
      stdoutPath: join(candidate.outputDirectory, "stdout"),
      stderrPath: join(candidate.outputDirectory, "stderr"),
      finalMessagePath: join(candidate.outputDirectory, "final"),
    }));
    const input = createTestAgentRunContext({
      changeId: candidate.changeId,
      attemptId: candidate.attemptId,
      worktree: candidate.path,
      requestPath: join(candidate.path, ".agent-input", "request.json"),
      planPath: join(candidate.path, ".agent-input", "plan.json"),
      policyPath: join(candidate.path, ".agent-input", "policy.json"),
      resultSchemaPath: join(root, "schema.json"),
      outputDirectory: candidate.outputDirectory,
    });
    try {
      assert.equal((await run.agent.run(input)).adapter, "fixture");
      await run.dispose();
      await assert.rejects(run.agent.run(input), /capacidad FixtureAgent/i);
    } finally {
      await removeCandidateWorktree(candidate);
    }
  });
});

test("fixture disposal waits for an active leased handler", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan: plan(baseline),
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath: await writeInput(root, "request.json"),
      planPath: await writeInput(root, "plan.json"),
      policyPath: await writeInput(root, "policy.json"),
    });
    let entered!: () => void;
    let release!: () => void;
    const enteredRun = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const run = await createFixtureAgentRun(candidate, async () => {
      entered();
      await released;
      return {
        exitCode: 0,
        generatedFiles: [],
        stdoutPath: "stdout",
        stderrPath: "stderr",
        finalMessagePath: "final",
      };
    });
    const input = createTestAgentRunContext({
      changeId: candidate.changeId,
      attemptId: candidate.attemptId,
      worktree: candidate.path,
      requestPath: join(candidate.path, ".agent-input", "request.json"),
      planPath: join(candidate.path, ".agent-input", "plan.json"),
      policyPath: join(candidate.path, ".agent-input", "policy.json"),
      resultSchemaPath: join(root, "schema.json"),
      outputDirectory: candidate.outputDirectory,
    });
    const active = run.agent.run(input);
    await enteredRun;
    let disposed = false;
    const disposing = run.dispose().then(() => (disposed = true));
    await Promise.resolve();
    assert.equal(disposed, false);
    release();
    await active;
    await disposing;
    await assert.rejects(run.agent.run(input), /capacidad FixtureAgent/i);
  });
});

test("permits only safe descendants of explicitly planned generated roots", async () => {
  await withRepository(async ({ root, baseline }) => {
    const base = plan(baseline);
    const unsigned = {
      ...base,
      files: [
        ...base.files,
        {
          path: "src/components/generated/agent-isolation",
          operation: "create" as const,
        },
        {
          path: "public/generated/agent-isolation",
          operation: "create" as const,
        },
      ],
    };
    const { planSha256: ignored, ...withoutHash } = unsigned;
    void ignored;
    const approvedPlan = {
      ...withoutHash,
      planSha256: sha256Canonical(withoutHash),
    };
    const requestPath = await writeInput(root, "request.json");
    const planPath = join(root, "planned.json");
    const policyPath = await writeInput(root, "policy.json");
    await writeFile(planPath, JSON.stringify(approvedPlan), "utf8");
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      approvedPlan,
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath,
      planPath,
      policyPath,
    });
    try {
      const component = join(
        candidate.path,
        "src/components/generated/agent-isolation/Card.astro",
      );
      const asset = join(
        candidate.path,
        "public/generated/agent-isolation/logo.svg",
      );
      await mkdir(dirname(component), { recursive: true });
      await mkdir(dirname(asset), { recursive: true });
      await Promise.all([
        writeFile(component, "<div />"),
        writeFile(asset, "<svg />"),
      ]);
      assert.deepEqual(await validateWorktreeDiff(candidate, approvedPlan), [
        "public/generated/agent-isolation/logo.svg",
        "src/components/generated/agent-isolation/Card.astro",
      ]);
    } finally {
      await removeCandidateWorktree(candidate);
    }
  });
});

async function writeInput(root: string, name: string): Promise<string> {
  const path = join(root, name);
  const content =
    name === "request.json"
      ? JSON.stringify(request())
      : name === "plan.json"
        ? JSON.stringify(plan(fixtureBaseline))
        : "{}";
  await writeFile(path, content, "utf8");
  return path;
}
