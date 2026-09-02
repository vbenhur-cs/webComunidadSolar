import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const localEnvironmentPattern = /^(?:\.dev\.vars|\.env)(?:\.|$)/;

async function collectRegularFiles(root: string): Promise<string[]> {
  const stat = await lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("El directorio de build no es un directorio regular");
  }

  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name, "en"),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const entryStat = await lstat(path);
      if (entryStat.isSymbolicLink()) {
        throw new Error("El build contiene un enlace simbólico no publicable");
      }
      if (entryStat.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entryStat.isFile()) {
        throw new Error("El build contiene un objeto no publicable");
      }
      if (localEnvironmentPattern.test(basename(path))) {
        throw new Error("El build contiene un archivo local de entorno");
      }
      files.push(path);
    }
  };

  await visit(root);
  return files;
}

export async function verifyBuildOutput(
  root: string,
  operatorCredentials: readonly string[],
): Promise<void> {
  const files = await collectRegularFiles(resolve(root));
  const credentials = operatorCredentials.filter((value) => value.length >= 8);
  if (credentials.length === 0) return;

  for (const path of files) {
    const contents = await readFile(path);
    if (credentials.some((value) => contents.includes(Buffer.from(value)))) {
      throw new Error("El build contiene una credencial de operador");
    }
  }
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function localOperatorCredentials(): Promise<string[]> {
  const keys = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] as const;
  const values = keys.map((key) => process.env[key] ?? "");
  try {
    const path = resolve(".env");
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return values;
    const lines = (await readFile(path, "utf8")).split(/\r?\n/);
    for (const key of keys) {
      const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`);
      const match = lines.map((line) => line.match(pattern)).find(Boolean);
      if (match?.[1] !== undefined) values.push(unquote(match[1].trim()));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return values;
}

async function main(): Promise<void> {
  await verifyBuildOutput("dist", await localOperatorCredentials());
  process.stdout.write("BUILD_OUTPUT_SECRET_CHECK_OK\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Falló la verificación del build"}\n`,
    );
    process.exitCode = 1;
  });
}
