import { relative, resolve } from "node:path";

import type { IsolationBroker } from "./types.ts";

const operatorBrokers = new WeakSet<object>();

export function createOperatorIsolationBroker(
  wrap: IsolationBroker["wrap"],
): IsolationBroker {
  const broker = Object.freeze({ wrap });
  operatorBrokers.add(broker);
  return broker;
}

export function assertOperatorIsolationBroker(
  broker: unknown,
): asserts broker is IsolationBroker {
  if (
    typeof broker !== "object" ||
    broker === null ||
    !operatorBrokers.has(broker) ||
    typeof (broker as { wrap?: unknown }).wrap !== "function"
  ) {
    throw new TypeError(
      "El command adapter exige un isolation broker del operador",
    );
  }
}

/**
 * Test-only broker for injected fixture agents. Product code must provide an
 * operator-managed broker with an OS-level write boundary.
 */
export function testIsolationBroker(worktree: string): IsolationBroker {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError("El broker de fixture solo existe en modo de prueba");
  }
  const safeWorktree = resolve(worktree);
  return createOperatorIsolationBroker(
    ({ worktree: candidate, command, args }) => {
      const candidatePath = resolve(candidate);
      if (
        candidatePath !== safeWorktree ||
        relative(safeWorktree, candidatePath).startsWith("..")
      ) {
        throw new TypeError("El broker no autoriza ese worktree");
      }
      return { command, args, env: {} };
    },
  );
}
