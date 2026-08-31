# Practical Agent Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the linked-Git-worktree authority in Task 7 with a brokered,
Git-less disposable agent workspace and a byte-copy handoff into a clean,
controller-owned staging tree.

**Architecture:** The controller exports the approved baseline into a new
workspace without `.git`, records a structural manifest and copies authoritative
inputs. A required operator broker owns the whole agent process and returns only
after its job ends. The controller treats all returned bytes as hostile,
recomputes the manifest and input hashes, then copies only planned regular files
into a freshly exported staging tree for Task 8's Astro policy.

**Tech Stack:** TypeScript, Node 22 filesystem APIs, `node:test`, Ajv schema
validation, `/usr/bin/git archive`, Codex CLI contract tests.

**Spec:**
`docs/superpowers/specs/2026-08-31-task-7-practical-isolation-design.md` and
`docs/superpowers/specs/2026-08-21-astro-parity-ingestion-design.md`.

## Global Constraints

- Treat request, plan copies, prompt content, agent process, protocol and every
  post-run workspace byte as untrusted.
- Treat the operator broker, controller, host and Git executable as trusted;
  do not claim protection from a concurrent equal-authority local process.
- Agent workspaces contain no `.git`, `.change-state`, source sibling,
  credentials, deployment configuration or publication authority.
- Production adapters require an operator-created `IsolationBroker`; test
  fixtures require `INGEST_TEST_MODE=true` and are not publishable.
- Use argv-only child process execution. No input-derived command, shell,
  environment key or filesystem path may gain authority.
- Broker networking is disabled by default. No request field can enable it.
- Import generated output by opening regular files without symlink traversal
  and copying bytes into a new controller-owned staging tree.
- Preserve Gate 1, Gate 2, validation, candidate commit and publication outside
  the agent process.
- Do not make an external deploy, call a real Codex generation, or alter the
  source reference during implementation.

## File Structure

```text
src/ingest/agents/types.ts           Broker and adapter contracts
src/ingest/agents/isolation.ts       Opaque operator and test broker capabilities
src/ingest/agents/command.ts         Command adapter delegated wholly to broker
src/ingest/agents/codex.ts           Codex argv plus untrusted final-message reader
src/ingest/agents/fixture.ts         Test-only adapter capability
src/ingest/workspaces/service.ts     Baseline export, manifests, inputs and cleanup
src/ingest/workspaces/policy.ts      Structural output validation and staging import
tests/ingest/agents.test.ts          Task 7 acceptance suite
tests/fixtures/ingestion/command-agent.mjs
                                     Fixture protocol producer
docs/operations/agent-isolation.md   Operational trust boundary and broker contract
docs/superpowers/plans/2026-08-21-astro-04-ingestion-publication.md
                                     Reconciled Task 7 / Task 8 interface
```

The retired `src/ingest/worktrees/*` implementation and its
`manifest-scanner.mjs` are removed once the focused workspace suite is green.
No later production module imports those files at this point in the plan.

---

### Task 1: Establish the broker-owned execution contract

**Files:**
- Modify: `src/ingest/agents/types.ts`
- Modify: `src/ingest/agents/isolation.ts`
- Modify: `src/ingest/agents/command.ts`
- Modify: `tests/ingest/agents.test.ts`

**Interfaces:**
- Consumes: operator-owned executable configuration and a workspace path from
  the later workspace service.
- Produces: `IsolationBroker.run`, `BrokerRunInput`, `BrokerRunResult` and
  `AgentRunResult` with captured untrusted strings rather than service-owned
  sidecar paths.

- [ ] **Step 1: Replace the legacy broker tests with failing execution-contract tests**

```ts
test("command adapter delegates one complete argv-only job to the broker", async () => {
  const calls: BrokerRunInput[] = [];
  const broker = createOperatorIsolationBroker(async (input) => {
    calls.push(input);
    return { exitCode: 0, stdout: '{"generatedFiles":[]}', stderr: "", timedOut: false };
  });
  await new CommandAgent({ command: process.execPath, args: [fixtureAgent] }, broker)
    .run(agentInput(workspace));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.workspace, workspace.path);
  assert.deepEqual(calls[0]?.env, { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
  assert.equal(calls[0]?.args.includes("--shell"), false);
});

test("production command adapter rejects no broker and a structural broker", async () => {
  await assert.rejects(() => new CommandAgent(config, null).run(input), /broker/i);
  await assert.rejects(() => new CommandAgent(config, { run: async () => result } as never).run(input), /broker/i);
});

test("broker timeout and non-zero exit never produce generated files", async () => {
  const timedOut = createOperatorIsolationBroker(async () => ({
    exitCode: 124, stdout: "", stderr: "deadline", timedOut: true,
  }));
  await assert.rejects(() => new CommandAgent(config, timedOut).run(input), /timeout/i);
});
```

- [ ] **Step 2: Run the focused tests and confirm the legacy wrap contract fails**

Run: `INGEST_TEST_MODE=true npm run test:unit -- tests/ingest/agents.test.ts`

Expected: FAIL because `IsolationBroker` exposes `wrap`, no adapter invokes a
broker-owned `run`, and timeout is not represented by the result contract.

- [ ] **Step 3: Define opaque broker capabilities and broker-owned process results**

```ts
export interface BrokerRunInput {
  workspace: string;
  command: string;
  args: readonly string[];
  stdin: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface BrokerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface AgentRunInput {
  changeId: string;
  attemptId: string;
  workspace: string;
  requestPath: string;
  planPath: string;
  policyPath: string;
  resultSchemaPath: string;
  timeoutMs: number;
}

export interface IsolationBroker {
  run(input: BrokerRunInput): Promise<BrokerRunResult>;
}

export interface AgentRunResult {
  adapter: string;
  exitCode: number;
  generatedFiles: string[];
  stdout: string;
  stderr: string;
  finalMessage: string;
}
```

Keep `createOperatorIsolationBroker(run)` as the only production capability
factory, backed by a `WeakSet`. Make `assertOperatorIsolationBroker` reject any
structural lookalike. Make `testIsolationBroker` construct a capability only
when `INGEST_TEST_MODE === "true"`; its runner must reject a workspace other
than the injected test workspace and call `runProcess` with `shell: false`.

Update `CommandAgent.run` to build one `BrokerRunInput` from trusted config,
call `broker.run`, reject `timedOut` or nonzero exit, parse `stdout` using
`agent-result.schema.json`, and return captured strings. Retain NUL rejection
for configured command and args; never accept them from the request.

- [ ] **Step 4: Run the focused broker tests and static checks**

Run: `INGEST_TEST_MODE=true npm run test:unit -- tests/ingest/agents.test.ts`

Expected: PASS for broker delegation, capability rejection, no-shell environment
and timeout/nonzero failure.

Run: `npm run lint && npm run check`

Expected: exit 0; retain only the repository's documented pre-existing hints.

- [ ] **Step 5: Commit the broker contract**

```bash
git add src/ingest/agents/types.ts src/ingest/agents/isolation.ts src/ingest/agents/command.ts tests/ingest/agents.test.ts
git commit -m "refactor: make agent brokers own execution"
```

### Task 2: Materialize a Git-less workspace and immutable input manifest

**Files:**
- Create: `src/ingest/workspaces/service.ts`
- Modify: `tests/ingest/agents.test.ts`

**Interfaces:**
- Consumes: `ChangePlan`, a trusted repository root, an approved baseline,
  authoritative request/plan/policy/schema files and safe `changeId`/
  `attemptId` values.
- Produces: `AgentWorkspace`, `createAgentWorkspace`, `workspaceInputs`,
  `workspaceManifest`, `assertWorkspaceInputs`,
  `assertTrustedRepositoriesUnchanged` and `removeAgentWorkspace`.

- [ ] **Step 1: Write failing workspace export and input-integrity tests**

```ts
test("exports the approved baseline into a disposable workspace without Git or operational state", async () => {
  const workspace = await createAgentWorkspace(workspaceInput(repository));
  assert.equal(await exists(join(workspace.path, ".git")), false);
  assert.equal(await readFile(join(workspace.path, "README.md"), "utf8"), "fixture\n");
  assert.equal(await exists(join(workspace.path, ".change-state")), false);
  await removeAgentWorkspace(workspace);
});

test("rejects a mutated copied request before accepting output", async () => {
  const workspace = await createAgentWorkspace(workspaceInput(repository));
  await writeFile(workspace.requestPath, '{"changed":true}', "utf8");
  await assert.rejects(() => assertWorkspaceInputs(workspace), /entrada copiada/i);
});

test("requires a fresh safe identifier pair and does not delete an occupied directory", async () => {
  await mkdir(expectedWorkspacePath, { recursive: true });
  await assert.rejects(() => createAgentWorkspace(workspaceInput(repository)), /ocupado/i);
  assert.equal(await exists(expectedWorkspacePath), true);
});

test("records and rejects controller or source-repository drift around an attempt", async () => {
  const workspace = await createAgentWorkspace(workspaceInput(repository));
  await writeFile(join(repository.root, "outside.txt"), "changed", "utf8");
  await assert.rejects(() => assertTrustedRepositoriesUnchanged(workspace), /repositorio.*cambió/i);
});
```

- [ ] **Step 2: Run the workspace subset and confirm it fails**

Run: `INGEST_TEST_MODE=true npm run test:unit -- tests/ingest/agents.test.ts`

Expected: FAIL because `src/ingest/workspaces/service.ts` and its exports do
not exist.

- [ ] **Step 3: Implement baseline export, safe manifest and authoritative input copies**

```ts
export interface AgentWorkspace {
  readonly path: string;
  readonly repositoryRoot: string;
  readonly baselineCommit: string;
  readonly changeId: string;
  readonly attemptId: string;
  readonly requestPath: string;
  readonly planPath: string;
  readonly policyPath: string;
  readonly resultSchemaPath: string;
  readonly baselineManifest: ReadonlyMap<string, ManifestEntry>;
}

export interface AgentWorkspaceInput {
  repositoryRoot: string;
  sourceRepositoryRoot?: string;
  workspaceRoot: string;
  approvedPlan: ChangePlan;
  changeId: string;
  attemptId: string;
  baselineCommit: string;
  requestPath: string;
  planPath: string;
  policyPath: string;
  resultSchemaPath: string;
}

export interface ManifestEntry {
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly bytes: number;
  readonly sha256: string | null;
}

export interface TrustedRepositorySnapshot {
  readonly head: string;
  readonly status: string;
}
```

Validate IDs with the existing lowercase-dash grammar and validate the baseline
as a 40–64 character lowercase hexadecimal commit. Create the workspace at
`<workspaceRoot>/<changeId>/<attemptId>` below an application-owned temporary
root; reject a pre-existing target rather than deleting it. Export the baseline with a fixed `/usr/bin/git`
argv-only `archive --format=tar <baseline>` piped to a fixed `tar -xf - -C
<workspace>` process. Do not use a shell or inherited Git configuration.

Walk the exported tree without following symlinks. Reject a symlink, special
file, path with an empty/dot/traversal segment, or regular file with `nlink !==
1`; record relative path, kind, mode, byte count and SHA-256. Copy the four
authoritative files into `.agent-input/`, compute a private hash record, and
exclude `.agent-input/` and `.agent-output/` from the source-tree baseline
manifest. `assertWorkspaceInputs` compares current file bytes to that private
record. Create `.agent-output/` before the broker runs, but do not include it
in either accepted manifest. Capture `HEAD` and `status --porcelain=v1 -z` for
the controller repository and optional source repository before export;
`assertTrustedRepositoriesUnchanged` repeats those fixed argv-only reads and
rejects any difference. `removeAgentWorkspace` only removes an owned object
from its private `WeakMap` after canonical-root validation; cleanup failure
leaves the workspace for diagnosis.

- [ ] **Step 4: Run workspace tests and project checks**

Run: `INGEST_TEST_MODE=true npm run test:unit -- tests/ingest/agents.test.ts`

Expected: PASS for Git-less export, safe target handling, manifest capture and
input mutation rejection.

Run: `npm run lint && npm run check`

Expected: exit 0.

- [ ] **Step 5: Commit the disposable workspace service**

```bash
git add src/ingest/workspaces/service.ts tests/ingest/agents.test.ts
git commit -m "feat: export isolated agent workspaces"
```

### Task 3: Validate hostile output and copy it to a clean staging tree

**Files:**
- Create: `src/ingest/workspaces/policy.ts`
- Modify: `src/ingest/agents/codex.ts`
- Modify: `src/ingest/agents/fixture.ts`
- Modify: `tests/ingest/agents.test.ts`
- Modify: `tests/fixtures/ingestion/command-agent.mjs`

**Interfaces:**
- Consumes: a live `AgentWorkspace`, the approved `ChangePlan` and its private
  baseline/input records.
- Produces: `validateAgentWorkspaceOutput(workspace, plan): Promise<StagedAgentOutput>`;
  the staging tree is a clean baseline export plus byte-copied allowed output,
  and `removeStagedAgentOutput` owns its cleanup.

- [ ] **Step 1: Write failing output-policy and clean-copy tests**

```ts
test("builds the accepted inventory independently of the agent's declared file list", async () => {
  await writeFile(join(workspace.path, "src/pages/generated.astro"), "---\n---\n<h1>x</h1>");
  const staged = await validateAgentWorkspaceOutput(workspace, plan);
  assert.deepEqual(Object.keys(staged).sort(), ["files", "path", "sha256"]);
  assert.notEqual(dirname(staged.path), dirname(workspace.path));
  assert.deepEqual(staged.files, ["src/pages/generated.astro"]);
  assert.equal(await readFile(join(staged.path, "src/pages/generated.astro"), "utf8"), "---\n---\n<h1>x</h1>");
  await removeStagedAgentOutput(staged);
});

for (const setup of [
  () => symlink("/tmp/outside", join(workspace.path, "src/pages/generated.astro")),
  () => writeFile(join(workspace.path, "package.json"), "{}"),
  () => link(join(workspace.path, "README.md"), join(workspace.path, "src/pages/generated.astro")),
]) {
  test("rejects hostile or unplanned workspace output", async () => {
    await setup();
    await assert.rejects(() => validateAgentWorkspaceOutput(workspace, plan));
  });
}

test("Codex reads a schema-valid final message only from agent output", async () => {
  await writeFile(join(workspace.path, ".agent-output", "final.json"), '{"generatedFiles":[]}', "utf8");
  const result = await codex.run(agentInput(workspace));
  assert.deepEqual(result.generatedFiles, []);
});

test("stages plan-declared dependency manifests only when Gate 1 declared dependencies", async () => {
  const dependencyPlan = planWith({
    dependencies: ["example@1.2.3"],
    files: [
      { path: "package.json", operation: "modify" },
      { path: "package-lock.json", operation: "modify" },
    ],
  });
  await writeFile(join(workspace.path, "package.json"), '{"dependencies":{"example":"1.2.3"}}');
  await writeFile(join(workspace.path, "package-lock.json"), '{"lockfileVersion":3}');
  const staged = await validateAgentWorkspaceOutput(workspace, dependencyPlan);
  assert.deepEqual(staged.files, ["package-lock.json", "package.json"]);
});
```

- [ ] **Step 2: Run the output subset and confirm it fails**

Run: `INGEST_TEST_MODE=true npm run test:unit -- tests/ingest/agents.test.ts`

Expected: FAIL because the workspace policy and staging output do not exist and
the legacy Codex adapter still depends on a service-owned sidecar directory.

- [ ] **Step 3: Implement structural validation and safe byte-copy staging**

```ts
export interface StagedAgentOutput {
  readonly path: string;
  readonly files: readonly string[];
  readonly sha256: Readonly<Record<string, string>>;
}

export async function validateAgentWorkspaceOutput(
  workspace: AgentWorkspace,
  plan: ChangePlan,
): Promise<StagedAgentOutput>;

export async function removeStagedAgentOutput(
  output: StagedAgentOutput,
): Promise<void>;
```

First call `assertWorkspaceInputs`. Rewalk the workspace without following
symlinks, reject special files and unsafe hardlinks, compare the source-tree
manifest against the baseline and derive changed paths independently. Permit
only `plan.files` plus descendants of a generated root explicitly present in
`plan.files`. As the sole structural exception, permit `package.json` and
`package-lock.json` only when each is explicitly listed in `plan.files` and
`plan.dependencies` is nonempty; Task 8 must later compare their exact allowed
dependency diff. Re-export the original baseline into a new controller-owned
staging directory beneath a separate temporary root. Both root and output use
opaque generated suffixes and neither encodes `changeId` nor `attemptId`; the
root must be disjoint from the workspace root. Then copy accepted regular files
using new byte buffers and verify hashes on both sides. Preserve `.agent-input`
and `.agent-output` outside the staging tree. Return exactly the
controller-owned staging path, sorted immutable inventory and hashes; do not
expose the hostile `AgentWorkspace` through `StagedAgentOutput` or make it a
derivable sibling. The controller retains workspace cleanup separately and
uses an ownership-bound `removeStagedAgentOutput` to remove the whole private
staging root.

Update `CodexAgent` to delegate its job to the broker and use
`.agent-output/final-message.json` inside the workspace as untrusted output;
read it with a non-symlink regular-file helper and validate it through the
closed `agent-result` schema. Update `FixtureAgent` to remain capability-bound
and test-only, but to operate on `AgentWorkspace` and never create/remove Git
worktrees. Update the command fixture to emit only schema-valid JSON on stdout.

- [ ] **Step 4: Run focused output tests, full unit suite and build**

Run: `INGEST_TEST_MODE=true npm run test:unit -- tests/ingest/agents.test.ts`

Expected: PASS for independent inventory, traversal/symlink/hardlink/unplanned
rejection, byte-copy staging and fixture/Codex contracts.

Run: `npm run test:unit && npm run lint && npm run check && npm run build && npm run source:check`

Expected: all commands exit 0; no source repository mutation occurs.

- [ ] **Step 5: Commit output validation and staging handoff**

```bash
git add src/ingest/workspaces/policy.ts src/ingest/agents/codex.ts src/ingest/agents/fixture.ts tests/ingest/agents.test.ts tests/fixtures/ingestion/command-agent.mjs
git commit -m "feat: validate and stage hostile agent output"
```

### Task 4: Retire false worktree guarantees and close Task 7

**Files:**
- Delete: `src/ingest/worktrees/service.ts`
- Delete: `src/ingest/worktrees/policy.ts`
- Delete: `src/ingest/worktrees/manifest-scanner.mjs`
- Modify: `docs/superpowers/plans/2026-08-21-astro-04-ingestion-publication.md`
- Create: `docs/operations/agent-isolation.md`
- Create: `docs/operations/task-7-closeout.md`
- Modify: `tests/ingest/agents.test.ts`

**Interfaces:**
- Consumes: broker contract, `AgentWorkspace` and `StagedAgentOutput` from
  Tasks 1–3.
- Produces: a reconciled Task 7 contract consumed by Task 8 and an operational
  document that states the trusted boundary without claiming OS isolation.

- [ ] **Step 1: Add failing regression assertions for retired Git authority**

```ts
test("agent workspace API exposes no Git worktree or candidate-ref authority", async () => {
  const source = await readFile("src/ingest/workspaces/service.ts", "utf8");
  assert.doesNotMatch(source, /git worktree add|candidate\//);
  const workspace = await createAgentWorkspace(workspaceInput(repository));
  assert.equal(await exists(join(workspace.path, ".git")), false);
});
```

Delete tests whose sole asserted property is resistance to an equal-authority
external process swapping a path between controller operations. Retain tests
for ordinary input mutation, symlink traversal, unplanned files, broker
capability, source/repository before/after guards and safe staging copies.

- [ ] **Step 2: Run the Task 7 test suite and confirm retired imports fail**

Run: `INGEST_TEST_MODE=true npm run test:unit -- tests/ingest/agents.test.ts`

Expected: FAIL until all `worktrees/*` imports and old candidate API usages are
removed.

- [ ] **Step 3: Remove the linked-worktree implementation and reconcile the plan**

Remove the three retired files with an `apply_patch` deletion after confirming
`rg` shows no production consumers. In the Phase 4 plan, replace Task 7's
worktree language with the approved `AgentWorkspace` / `StagedAgentOutput`
interface, add the adenda path to `Spec`, and state that Task 8 receives the
controller-owned staging path and inventory. In
`docs/operations/agent-isolation.md`, document the trusted components,
out-of-scope concurrent-local-process boundary, deployment requirement for a
container/VM broker in a multi-tenant environment, required no-shell/minimal-
environment/timeout behavior and the prohibition on passing publication
credentials to agents.

In `docs/operations/task-7-closeout.md`, record the implementation commit IDs,
test commands/results, source guard result, known residual boundary and the
explicit statement that Task 8 is next. It must list the new contract and avoid
claiming OS-level protection. Append the same short outcome to the ignored SDD
ledger for local recovery, but do not attempt to stage ignored files.

- [ ] **Step 4: Run the full Task 7 closeout matrix**

Run: `INGEST_TEST_MODE=true npm run test:unit -- tests/ingest/agents.test.ts`

Expected: all focused Task 7 tests pass.

Run: `npm run format:check && npm run lint && npm run check && npm run test:unit && npm run build && npm run source:check && git diff --check`

Expected: every command exits 0. `git status --short` contains only intended
Task 7 closeout documentation before the commit.

- [ ] **Step 5: Commit the Task 7 closeout**

```bash
git add -A src/ingest/agents src/ingest/workspaces src/ingest/worktrees tests/ingest/agents.test.ts tests/fixtures/ingestion/command-agent.mjs docs/operations/agent-isolation.md docs/operations/task-7-closeout.md docs/superpowers/plans/2026-08-21-astro-04-ingestion-publication.md
git commit -m "feat: close practical agent isolation task"
```

## Follow-on Execution

After Task 4, execute Tasks 8–12 in
`docs/superpowers/plans/2026-08-21-astro-04-ingestion-publication.md` in order.
The only interface change is that Task 8 receives only
`StagedAgentOutput.path`, its independently derived `files` inventory and
`sha256` map instead of an agent-owned Git worktree. It does not receive the
`AgentWorkspace`; workspace cleanup/lifecycle remains controller-internal.
Then execute master-plan Task 5 (`verify-complete.ts` and the completion audit)
against the final repository state.
