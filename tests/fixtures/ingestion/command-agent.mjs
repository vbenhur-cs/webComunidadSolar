import { readFile, writeFile } from "node:fs/promises";

const input = JSON.parse(await readFile(0, "utf8"));
await writeFile(
  input.resultPath,
  JSON.stringify({ generatedFiles: ["src/pages/generated.astro"] }),
  "utf8",
);
process.stdout.write("fixture agent completed\\n");
