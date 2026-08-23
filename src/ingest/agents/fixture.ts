import type { AgentAdapter, AgentRunInput, AgentRunResult } from "./types.ts";

export type FixtureAgentHandler = (
  input: AgentRunInput,
) => Promise<Omit<AgentRunResult, "adapter">>;

const fixtureCapabilities = new WeakSet<object>();

/** Create an opaque test-only fixture capability. It is never a CLI provider. */
export function createFixtureAgent(handler: FixtureAgentHandler): AgentAdapter {
  if (process.env.INGEST_TEST_MODE !== "true") {
    throw new TypeError(
      "FixtureAgent solo puede inyectarse en clones de prueba",
    );
  }
  const capability = {};
  fixtureCapabilities.add(capability);
  return {
    name: "fixture",
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      if (!fixtureCapabilities.has(capability)) {
        throw new TypeError("La capacidad FixtureAgent ya no es válida");
      }
      if (!input.worktree.includes(".agent-worktrees")) {
        throw new TypeError("FixtureAgent exige un worktree aislado de prueba");
      }
      return { adapter: "fixture", ...(await handler(input)) };
    },
  };
}
