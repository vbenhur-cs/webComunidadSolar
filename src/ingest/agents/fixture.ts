import { lstat, realpath } from "node:fs/promises";

import {
  assertWorkspaceInputs,
  workspaceInputs,
  type AgentWorkspace,
  type AgentWorkspaceInputs,
} from "../workspaces/service.ts";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "./types.ts";

export type FixtureAgentHandler = (
  input: AgentRunInput,
) => Promise<Omit<AgentRunResult, "adapter">>;

interface WorkspaceIdentity {
  device: number;
  inode: number;
}

interface FixtureRunState {
  workspace: AgentWorkspace;
  input: AgentWorkspaceInputs;
  identity: WorkspaceIdentity;
  closed: boolean;
  active: number;
  drained: Promise<void>;
  release?: () => void;
}

const runs = new WeakMap<object, FixtureRunState>();

export interface FixtureAgentRun {
  readonly agent: AgentAdapter;
  dispose(): Promise<void>;
}

function sameInput(
  input: AgentRunInput,
  expected: AgentWorkspaceInputs,
): boolean {
  return (
    input.changeId === expected.changeId &&
    input.attemptId === expected.attemptId &&
    input.workspace === expected.workspace &&
    input.worktree === expected.workspace &&
    input.requestPath === expected.requestPath &&
    input.planPath === expected.planPath &&
    input.policyPath === expected.policyPath &&
    input.resultSchemaPath === expected.resultSchemaPath
  );
}

/**
 * Fixture agents are test capabilities bound to one owned AgentWorkspace.
 * Disposal closes the capability; workspace lifecycle remains controller-owned.
 */
export async function createFixtureAgentRun(
  workspace: AgentWorkspace,
  handler: FixtureAgentHandler,
): Promise<FixtureAgentRun> {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError("FixtureAgent solo puede inyectarse en modo de prueba");
  }
  const input = workspaceInputs(workspace);
  await assertWorkspaceInputs(workspace);
  const entry = await lstat(workspace.path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new TypeError("La identidad del workspace fixture no es válida");
  }
  const token = {};
  const state: FixtureRunState = {
    workspace,
    input,
    identity: { device: entry.dev, inode: entry.ino },
    closed: false,
    active: 0,
    drained: Promise.resolve(),
  };
  runs.set(token, state);
  const agent: AgentAdapter = Object.freeze({
    name: "fixture",
    async run(agentInput: AgentRunInput): Promise<AgentRunResult> {
      const current = runs.get(token);
      if (!current || current.closed || !sameInput(agentInput, current.input)) {
        throw new TypeError("La capacidad FixtureAgent no es válida");
      }
      current.active += 1;
      if (current.active === 1) {
        current.drained = new Promise<void>((resolve) => {
          current.release = resolve;
        });
      }
      try {
        const actual = await lstat(current.workspace.path);
        if (
          actual.isSymbolicLink() ||
          !actual.isDirectory() ||
          actual.dev !== current.identity.device ||
          actual.ino !== current.identity.inode ||
          (await realpath(current.workspace.path)) !== current.workspace.path
        ) {
          throw new TypeError("La identidad del workspace fixture ha cambiado");
        }
        await assertWorkspaceInputs(current.workspace);
        return { adapter: "fixture", ...(await handler(agentInput)) };
      } finally {
        current.active -= 1;
        if (current.active === 0) current.release?.();
      }
    },
  });
  return Object.freeze({
    agent,
    async dispose(): Promise<void> {
      const current = runs.get(token);
      if (!current || current.closed) return;
      current.closed = true;
      await current.drained;
      runs.delete(token);
    },
  });
}
