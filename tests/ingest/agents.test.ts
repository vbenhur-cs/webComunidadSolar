import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { sha256Canonical } from "../../src/ingest/canonical-json.ts";
import type { ChangePlan } from "../../src/ingest/domain.ts";
import { CommandAgent } from "../../src/ingest/agents/command.ts";
import { codexInvocation } from "../../src/ingest/agents/codex.ts";
import type {
  AgentRunInput,
  IsolationBroker,
  ProcessRunOptions,
  ProcessRunner,
} from "../../src/ingest/agents/types.ts";
import {
  createCandidateWorktree,
  removeCandidateWorktree,
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

function plan(baselineCommit: string): ChangePlan {
  const unsigned = {
    schemaVersion: 1 as const,
    changeId: "agent-isolation",
    baselineCommit,
    requestSha256: hash("a"),
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
    await run({ root, baseline: await git(root, ["rev-parse", "HEAD"]) });
  } finally {
    await rm(root, { recursive: true, force: true });
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
  await Promise.all([
    writeFile(requestPath, '{"intent":"untrusted instructions"}', "utf8"),
    writeFile(planPath, "{}", "utf8"),
    writeFile(policyPath, "{}", "utf8"),
    writeFile(resultSchemaPath, "{}", "utf8"),
  ]);
  return {
    changeId: "agent-isolation",
    attemptId: "attempt-000001",
    worktree: candidatePath,
    requestPath,
    planPath,
    policyPath,
    resultSchemaPath,
  };
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
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  };
}

function recordingBroker(): IsolationBroker {
  return {
    wrap: ({ worktree, command, args }) => ({
      command: "/operator/broker",
      args: ["--worktree", worktree, "--", command, ...args],
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    }),
  };
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

test("command adapter delegates to an operator broker without a shell", async () => {
  const { runner, calls } = recordingRunner();
  const commandWorktree = await mkdtemp(
    join(tmpdir(), "comunidadsolar-command-input-"),
  );
  const input = await createInput(commandWorktree, commandWorktree);
  try {
    await new CommandAgent(
      { command: process.execPath, args: [fixtureAgent] },
      recordingBroker(),
      runner,
    ).run(input);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "/operator/broker");
    assert.equal(calls[0]?.options.shell, false);
    assert.deepEqual(calls[0]?.options.env, {
      PATH: "/usr/bin:/bin",
      LANG: "C",
    });
  } finally {
    await rm(dirname(input.requestPath), { recursive: true, force: true });
  }
});

test("command adapter refuses to run without an isolation broker", async () => {
  const { runner } = recordingRunner();
  await assert.rejects(
    new CommandAgent(
      { command: process.execPath, args: [fixtureAgent] },
      null,
      runner,
    ).run({
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      worktree: "/safe/worktree",
      requestPath: "/safe/request.json",
      planPath: "/safe/plan.json",
      policyPath: "/safe/policy.json",
      resultSchemaPath: "/safe/schema.json",
    }),
    /isolation broker/i,
  );
});

test("candidate worktree copies immutable inputs and cleans only its exact path", async () => {
  await withRepository(async ({ root, baseline }) => {
    const requestPath = join(root, "request.json");
    const planPath = join(root, "plan.json");
    const policyPath = join(root, "policy.json");
    await Promise.all([
      writeFile(requestPath, "request", "utf8"),
      writeFile(planPath, "plan", "utf8"),
      writeFile(policyPath, "policy", "utf8"),
    ]);
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
      changeId: "agent-isolation",
      attemptId: "attempt-000001",
      baselineCommit: baseline,
      requestPath,
      planPath,
      policyPath,
    });
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
        "request",
      );
    } finally {
      await removeCandidateWorktree(candidate);
    }
    await assert.rejects(stat(candidate.path));
  });
});

test("rejects an agent change outside approved output paths", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
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
      await assert.rejects(
        validateWorktreeDiff(candidate, plan(baseline)),
        /commit creado por el agente/i,
      );
    } finally {
      await removeCandidateWorktree(candidate);
    }
  });
});

test("rejects changed protected refs and mutated copied agent input", async () => {
  await withRepository(async ({ root, baseline }) => {
    const candidate = await createCandidateWorktree({
      repositoryRoot: root,
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

async function writeInput(root: string, name: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, name, "utf8");
  return path;
}
