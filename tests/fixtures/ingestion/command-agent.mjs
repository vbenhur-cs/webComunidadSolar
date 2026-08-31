let input = "";
for await (const chunk of process.stdin) input += chunk;
JSON.parse(input);
process.stdout.write(
  JSON.stringify({ generatedFiles: ["src/pages/generated.astro"] }),
);
