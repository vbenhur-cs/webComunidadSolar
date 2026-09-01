import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const context = JSON.parse(input);
const plan = JSON.parse(await readFile(context.planPath, "utf8"));
const workspace = dirname(dirname(context.requestPath));
const routePath =
  plan.targetPath === "/"
    ? "src/pages/index.astro"
    : `src/pages${plan.targetPath}.astro`;
const contentPath = `src/content/generated/${plan.changeId}.json`;
const stylePath = `src/styles/generated/${plan.changeId}.css`;

const route =
  plan.selectedMode === "blocks"
    ? `---\nimport GeneratedBlockPage from "../components/blocks/GeneratedBlockPage.astro";\nimport page from "../content/generated/${plan.changeId}.json";\n---\n<GeneratedBlockPage {page} />\n`
    : `---\nimport SiteLayout from "../layouts/SiteLayout.astro";\nimport "../styles/generated/${plan.changeId}.css";\n---\n<SiteLayout page="inicio">\n  <main class="generated-${plan.changeId}"><h1>Fixture verificable</h1><a href="/">Inicio</a></main>\n</SiteLayout>\n`;
const content = {
  schemaVersion: 1,
  changeId: plan.changeId,
  mode: plan.selectedMode,
  route: plan.targetPath,
  metadata: {
    title: "Fixture verificable",
    description: "Una página aislada con evidencia reproducible.",
    index: false,
  },
  privacy: { private: false, area: null },
  contentSha256: createHash("sha256").update(route).digest("hex"),
  ...(plan.selectedMode === "blocks"
    ? {
        blocks: [
          {
            type: "hero",
            eyebrow: "Fixture",
            title: "Página verificable",
            lead: "Contenido generado de forma aislada.",
            primary: { label: "Inicio", href: "/" },
          },
        ],
      }
    : {}),
};

for (const [path, source] of [
  [routePath, route],
  [contentPath, `${JSON.stringify(content)}\n`],
  ...(plan.selectedMode === "blocks"
    ? []
    : [[stylePath, `.generated-${plan.changeId} { color: #123456; }\n`]]),
]) {
  const destination = join(workspace, ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, source, "utf8");
}

process.stdout.write(
  JSON.stringify({
    generatedFiles: [routePath, contentPath].concat(
      plan.selectedMode === "blocks" ? [] : [stylePath],
    ),
  }),
);
