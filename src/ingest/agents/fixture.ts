import { lstat, realpath } from "node:fs/promises";

import {
  assertCandidateOwnership,
  removeCandidateWorktree,
  resolveAgentRunContext,
  type CandidateWorktree,
} from "../worktrees/service.ts";

import type { AgentAdapter, AgentRunInput, AgentRunResult } from "./types.ts";

export type FixtureAgentHandler = (
  input: AgentRunInput,
) => Promise<Omit<AgentRunResult, "adapter">>;

interface CandidateIdentity {
  device: number;
  inode: number;
}
const runs = new WeakMap<
  object,
  { candidate: CandidateWorktree; identity: CandidateIdentity; closed: boolean }
>();

export interface FixtureAgentRun {
  readonly agent: AgentAdapter;
  dispose(): Promise<void>;
}

/**
 * Fixture agents are test capabilities bound to one service-owned candidate.
 * No environment flag or structural object can mint a usable production agent.
 */
export async function createFixtureAgentRun(
  candidate: CandidateWorktree,
  handler: FixtureAgentHandler,
): Promise<FixtureAgentRun> {
  if (process.env.INGEST_TEST_MODE !== "true")
    throw new TypeError(
      "FixtureAgent solo puede inyectarse en clones de prueba",
    );
  await assertCandidateOwnership(candidate);
  const entry = await lstat(candidate.path);
  const token = {};
  const state = {
    candidate,
    identity: { device: entry.dev, inode: entry.ino },
    closed: false,
  };
  runs.set(token, state);
  const agent: AgentAdapter = Object.freeze({
    name: "fixture",
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const current = runs.get(token);
      if (
        !current ||
        current.closed ||
        input.worktree !== current.candidate.path
      )
        throw new TypeError("La capacidad FixtureAgent no es válida");
      await resolveAgentRunContext(input);
      const actual = await lstat(current.candidate.path);
      if (
        actual.isSymbolicLink() ||
        actual.dev !== current.identity.device ||
        actual.ino !== current.identity.inode ||
        (await realpath(current.candidate.path)) !== current.candidate.path
      )
        throw new TypeError("La identidad del candidato fixture ha cambiado");
      await assertCandidateOwnership(current.candidate);
      return { adapter: "fixture", ...(await handler(input)) };
    },
  });
  return Object.freeze({
    agent,
    async dispose(): Promise<void> {
      const current = runs.get(token);
      if (!current || current.closed) return;
      current.closed = true;
      runs.delete(token);
      await removeCandidateWorktree(current.candidate);
    },
  });
}
