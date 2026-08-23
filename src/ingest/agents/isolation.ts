import { relative, resolve } from "node:path";

import type { IsolationBroker } from "./types.ts";

/**
 * Test-only broker for injected fixture agents. Product code must provide an
 * operator-managed broker with an OS-level write boundary.
 */
export function testIsolationBroker(worktree: string): IsolationBroker {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError("El broker de fixture solo existe en modo de prueba");
  }
  const safeWorktree = resolve(worktree);
  return {
    wrap: ({ worktree: candidate, command, args }) => {
      const candidatePath = resolve(candidate);
      if (
        candidatePath !== safeWorktree ||
        relative(safeWorktree, candidatePath).startsWith("..")
      ) {
        throw new TypeError("El broker no autoriza ese worktree");
      }
      return { command, args, env: { PATH: process.env.PATH ?? "" } };
    },
  };
}
