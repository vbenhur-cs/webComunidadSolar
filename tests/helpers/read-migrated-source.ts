import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const bundles = {
  site: [
    "src/components/site",
    "src/components/pages",
    "src/components/islands",
  ],
  quote: ["src/lib/manganafer/quote.ts", "src/lib/manganafer/quote-config.ts"],
  consent: ["src/components/islands/ConsentManager.tsx"],
  guide: ["src/content/guide-content.md"],
  "legacy-routes": ["src/lib/routing/legacy.ts"],
  "legal-content": ["src/content/legal-content.ts"],
  robots: ["src/pages/robots.txt.ts"],
} as const;

export type MigratedSourceName = keyof typeof bundles;

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function lexicalCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function sourceFiles(path: string): Promise<string[]> {
  const details = await lstat(path);
  if (details.isSymbolicLink()) {
    throw new Error(`El bundle migrado no puede contener symlinks: ${path}`);
  }
  if (details.isFile()) return [path];
  if (!details.isDirectory()) return [];

  const files: string[] = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort(
    (left, right) => lexicalCompare(left.name, right.name),
  )) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(child)));
    } else if (entry.isFile() && /\.(?:astro|tsx)$/.test(entry.name)) {
      files.push(child);
    } else if (entry.isSymbolicLink()) {
      throw new Error(`El bundle migrado no puede contener symlinks: ${child}`);
    }
  }
  return files;
}

export async function readMigratedSource(
  name: MigratedSourceName,
  root = process.cwd(),
): Promise<string> {
  const repositoryRoot = await realpath(root);
  const paths = bundles[name];
  const files = (
    await Promise.all(
      paths.map(async (path) => {
        const absolutePath = resolve(repositoryRoot, path);
        if (!isWithin(repositoryRoot, absolutePath)) {
          throw new Error(`El bundle ${name} queda fuera del repositorio`);
        }
        try {
          return await sourceFiles(absolutePath);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      }),
    )
  )
    .flat()
    .sort(lexicalCompare);

  if (files.length === 0) {
    throw new Error(`El bundle migrado ${name} está vacío`);
  }
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join(
    "\n",
  );
}

export async function readProjectAsset(
  relativePath: string,
  root = process.cwd(),
): Promise<Buffer> {
  const repositoryRoot = await realpath(root);
  const publicRoot = resolve(repositoryRoot, "public");
  const asset = resolve(publicRoot, relativePath.replace(/^\/+/, ""));
  const realPublicRoot = await realpath(publicRoot);
  if (!isWithin(realPublicRoot, asset)) {
    throw new Error("El asset solicitado queda fuera de public");
  }
  let current = publicRoot;
  for (const segment of relative(publicRoot, asset)
    .split(sep)
    .filter(Boolean)) {
    current = resolve(current, segment);
    const currentDetails = await lstat(current);
    if (currentDetails.isSymbolicLink()) {
      throw new Error(
        `El asset local no puede atravesar symlinks: ${relativePath}`,
      );
    }
  }
  const realAsset = await realpath(asset);
  if (!isWithin(realPublicRoot, realAsset)) {
    throw new Error("El asset solicitado queda fuera de public");
  }
  const details = await lstat(asset);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`El asset local debe ser regular: ${relativePath}`);
  }
  return readFile(asset);
}
