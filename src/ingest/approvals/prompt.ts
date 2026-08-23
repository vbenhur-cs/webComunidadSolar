import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export interface ApprovalConfirmation {
  gate: 1 | 2;
  subjectSha256: string;
  summary: string;
}

/**
 * Boundary for a human acknowledgement. Production uses real terminal streams;
 * fixture runners supply their own explicit implementation.
 */
export interface ApprovalPrompt {
  readonly isTTY: boolean;
  readonly environment: "production" | "test";
  confirm(confirmation: ApprovalConfirmation): Promise<string>;
}

export function createProductionApprovalPrompt(): ApprovalPrompt {
  return {
    isTTY: stdin.isTTY === true && stdout.isTTY === true,
    environment: "production",
    async confirm({ gate, subjectSha256, summary }): Promise<string> {
      stdout.write(`\nGate ${gate}\n${summary}\nHash: ${subjectSha256}\n`);
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        return await prompt.question(
          `Escriba ${subjectSha256.slice(0, 12)} para aprobar: `,
        );
      } finally {
        prompt.close();
      }
    },
  };
}
