import { spawn } from "node:child_process";

interface ParsedArguments {
  scope: "all" | "public" | "server";
  testArguments: string[];
}

function parseArguments(arguments_: string[]): ParsedArguments {
  let scope: ParsedArguments["scope"] = "all";
  const testArguments: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--scope") {
      const candidate = arguments_[index + 1];
      if (
        candidate !== "all" &&
        candidate !== "public" &&
        candidate !== "server"
      ) {
        throw new Error("--scope debe ser all, public o server");
      }
      scope = candidate;
      index += 1;
      continue;
    }
    testArguments.push(argument);
  }

  return { scope, testArguments };
}

async function run(
  command: string,
  arguments_: string[],
  env = process.env,
): Promise<void> {
  const child = spawn(command, arguments_, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    shell: false,
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolve(value ?? 1));
  });
  if (code !== 0) {
    throw new Error(`${command} terminó con código ${code}`);
  }
}

async function main(): Promise<void> {
  const { scope, testArguments } = parseArguments(process.argv.slice(2));
  await run("npm", ["run", "build"]);
  await run(
    "./node_modules/.bin/tsx",
    [
      "--test",
      ...testArguments,
      "tests/contracts/reference-css.contract.mjs",
      "tests/contracts/rendered-html.contract.mjs",
    ],
    { ...process.env, CONTRACT_SCOPE: scope },
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
