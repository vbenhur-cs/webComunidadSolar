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
    requestPath,
    planPath,
    policyPath,
    resultSchemaPath,
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
          recordingBroker(),
          async () => ({ exitCode: 0, stdout, stderr: "" }),
        ).run(input),
        /(JSON válido|schema agent-result)/i,
      );
    }
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(input.outputDirectory!, { recursive: true, force: true });
  }
});

test("adapters reject a forged structural run input before spawning", async () => {
  const { runner, calls } = recordingRunner();
  await assert.rejects(
    new CommandAgent(
      { command: process.execPath, args: [] },
      recordingBroker(),
      runner,
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
  assert.equal(calls.length, 0);
});

test("frozen candidate projection cannot redirect a minted run context", async () => {
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
      const { runner, calls } = recordingRunner();
      await new CommandAgent(
        { command: process.execPath, args: [] },
        recordingBroker(),
        runner,
      ).run(context);
      assert.deepEqual(JSON.parse(calls[0]!.options.input), {
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
      assert.equal(
        await readFile(
          join(candidate.outputDirectory, "command.stdout.log"),
          "utf8",
        ),
        '{"generatedFiles":[]}',
      );
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
      const { runner, calls } = recordingRunner();
      await assert.rejects(
        new CommandAgent(
          { command: process.execPath, args: [] },
          recordingBroker(),
          runner,
        ).run(context),
        /salida.*cambi|identidad/i,
      );
      assert.equal(calls.length, 0);
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
      const { runner, calls } = recordingRunner();
      await assert.rejects(
        new CommandAgent(
          { command: process.execPath, args: [] },
          recordingBroker(),
          runner,
        ).run(context),
        /entrada.*cambi|identidad/i,
      );
      assert.equal(calls.length, 0);
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
  const original = await createInput(worktree, worktree);
  const input = createTestAgentRunContext({
    ...original,
    outputDirectory: output,
  });
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
    await rm(original.outputDirectory!, { recursive: true, force: true });
    await rm(output, { force: true });
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
