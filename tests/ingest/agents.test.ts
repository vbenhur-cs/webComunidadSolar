import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
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
import { codexInvocation } from "../../src/ingest/agents/codex.ts";
import { createOperatorIsolationBroker } from "../../src/ingest/agents/isolation.ts";
import { createFixtureAgentRun } from "../../src/ingest/agents/fixture.ts";
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
  return {
    changeId: "agent-isolation",
    attemptId: "attempt-000001",
    worktree: candidatePath,
    requestPath,
    planPath,
    policyPath,
    resultSchemaPath,
    outputDirectory,
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
  return createOperatorIsolationBroker(({ worktree, command, args }) => ({
    command: "/operator/broker",
    args: ["--worktree", worktree, "--", command, ...args],
    env: {},
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
      LC_ALL: "C",
    });
  } finally {
    await rm(dirname(input.requestPath), { recursive: true, force: true });
    await rm(input.outputDirectory!, { recursive: true, force: true });
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
      outputDirectory: "/safe/output",
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
    assert.ok((await stat(candidate.path)).isDirectory());
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
      assert.ok((await stat(candidate.path)).isDirectory());
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

test("command broker rejects unknown or loader-controlled environment values", async () => {
  const { runner } = recordingRunner();
  const worktree = await mkdtemp(join(tmpdir(), "comunidadsolar-command-env-"));
  const input = await createInput(worktree, worktree);
  try {
    const broker = createOperatorIsolationBroker(() => ({
      command: "/operator/broker",
      args: [],
      env: { PATH: "/usr/bin", NODE_OPTIONS: "--require /tmp/pwn" },
    }));
    await assert.rejects(
      new CommandAgent(
        { command: process.execPath, args: [] },
        broker,
        runner,
      ).run(input),
      /entorno|broker/i,
    );
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(input.outputDirectory!, { recursive: true, force: true });
  }
});

test("command result rejects traversal rather than trusting agent stdout", async () => {
  const worktree = await mkdtemp(
    join(tmpdir(), "comunidadsolar-command-result-"),
  );
  const input = await createInput(worktree, worktree);
  try {
    const runner: ProcessRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ generatedFiles: ["../escape.astro"] }),
      stderr: "",
    });
    await assert.rejects(
      new CommandAgent(
        { command: process.execPath, args: [] },
        recordingBroker(),
        runner,
      ).run(input),
      /path generado no seguro/i,
    );
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(input.outputDirectory!, { recursive: true, force: true });
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
    const input = {
      changeId: candidate.changeId,
      attemptId: candidate.attemptId,
      worktree: candidate.path,
      requestPath: join(candidate.path, ".agent-input", "request.json"),
      planPath: join(candidate.path, ".agent-input", "plan.json"),
      policyPath: join(candidate.path, ".agent-input", "policy.json"),
      resultSchemaPath: join(root, "schema.json"),
      outputDirectory: candidate.outputDirectory,
    };
    try {
      assert.equal((await run.agent.run(input)).adapter, "fixture");
      await run.dispose();
      await assert.rejects(run.agent.run(input), /capacidad FixtureAgent/i);
    } finally {
      await removeCandidateWorktree(candidate);
    }
  });
});

test("agent adapters reject a sidecar symlink outside the owned output root", async () => {
  const worktree = await mkdtemp(
    join(tmpdir(), "comunidadsolar-agent-worktree-"),
  );
  const outside = await mkdtemp(
    join(tmpdir(), "comunidadsolar-agent-outside-"),
  );
  const output = join(
    dirname(worktree),
    `${worktree.split("/").at(-1)}-output-link`,
  );
  await symlink(outside, output);
  const input = await createInput(worktree, worktree);
  input.outputDirectory = output;
  try {
    await assert.rejects(
      new CommandAgent(
        { command: process.execPath, args: [] },
        recordingBroker(),
        recordingRunner().runner,
      ).run(input),
      /salida.*seguro/i,
    );
  } finally {
    await rm(input.outputDirectory!, { force: true });
    await rm(worktree, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
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
