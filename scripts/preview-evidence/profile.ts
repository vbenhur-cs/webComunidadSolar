import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { prepareCloudflarePreviewConfig } from "../prepare-cloudflare-config.ts";

export interface PreviewProfileArtifact {
  path: string;
  sha256: string;
  workerName: string;
  databaseName: string;
  databaseId: string;
  indexable: false;
}

const maxProfileBytes = 64 * 1024;

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

async function ensureSafeDirectory(
  projectRoot: string,
  outputRoot: string,
): Promise<void> {
  const root = resolve(projectRoot);
  const output = resolve(outputRoot);
  if (!isInside(root, output)) {
    throw new TypeError(
      "El directorio del perfil debe estar dentro del proyecto",
    );
  }
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new TypeError(
      "El proyecto del perfil debe ser un directorio regular",
    );
  }

  let current = root;
  for (const part of relative(root, output).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new TypeError(
          "El directorio del perfil no puede contener symlinks",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

function decodeProfile(encoded: string): Buffer {
  const normalized = encoded.trim();
  if (
    normalized.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      normalized,
    )
  ) {
    throw new TypeError("El perfil preview debe usar base64 canónico");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (
    decoded.length > maxProfileBytes ||
    decoded.toString("base64") !== normalized
  ) {
    throw new RangeError("El perfil preview supera 64 KiB o no es canónico");
  }
  return decoded;
}

export async function materializePreviewProfile(
  encoded: string,
  outputRoot: string,
  projectRoot: string,
): Promise<PreviewProfileArtifact> {
  const resolvedProject = resolve(projectRoot);
  const resolvedOutput = resolve(outputRoot);
  await ensureSafeDirectory(resolvedProject, resolvedOutput);
  const decoded = decodeProfile(encoded);
  const temporaryPath = resolve(
    resolvedOutput,
    `.preview-operator-${randomUUID()}.jsonc`,
  );
  if (!isInside(resolvedOutput, temporaryPath)) {
    throw new TypeError("El temporal del perfil salió de artifacts");
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(decoded);
    await handle.close();
    handle = undefined;

    const prepared = await prepareCloudflarePreviewConfig(
      temporaryPath,
      undefined,
      {
        projectRoot: resolvedProject,
        artifactRoot: resolve(resolvedOutput, "config"),
      },
    );
    if (prepared.indexable) {
      throw new Error("El perfil preview no puede ser indexable");
    }
    return {
      path: prepared.outputPath,
      sha256: prepared.sha256,
      workerName: prepared.destination.workerName,
      databaseName: prepared.destination.database.name,
      databaseId: prepared.destination.database.id,
      indexable: false,
    };
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}
