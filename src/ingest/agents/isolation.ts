import { relative, resolve } from "node:path";

import {
  runProcess,
  type BrokerRunInput,
  type BrokerRunResult,
  type IsolationBroker,
} from "./types.ts";

const operatorBrokers = new WeakSet<object>();

export function createOperatorIsolationBroker(
  run: (input: BrokerRunInput) => Promise<BrokerRunResult>,
): IsolationBroker {
  const broker = Object.freeze({ run });
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
    typeof (broker as { run?: unknown }).run !== "function"
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
    async ({ workspace, command, args, stdin, env, timeoutMs }) => {
      const candidatePath = resolve(workspace);
      if (
        candidatePath !== safeWorktree ||
        relative(safeWorktree, candidatePath).startsWith("..")
      ) {
        throw new TypeError("El broker no autoriza ese workspace");
      }
      const result = await runProcess(command, [...args], {
        cwd: safeWorktree,
        env: { ...env },
        input: stdin,
        shell: false,
        timeoutMs,
      });
      return { ...result, timedOut: result.timedOut ?? false };
    },
  );
}
