import { extname } from "node:path";

import {
  copyRawRequest,
  normalizeIngestionText,
  normalizeRequestInput,
  parseSafeYaml,
  readRequestBytes,
  type RawArtifactOptions,
} from "./common.ts";
import { parseMarkdownFrontmatter } from "./frontmatter.ts";
import type { NormalizedRequest } from "../domain.ts";

export interface ImportRequestOptions extends RawArtifactOptions {
  /** Parses without writing intake so a controller can acquire the change lock. */
  readonly persistRaw?: boolean;
  /** Rejects a source that changed identity between preflight and the lock. */
  readonly expectedChangeId?: string;
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new TypeError("JSON de solicitud no válido");
  }
}

function parseInput(extension: string, source: string): unknown {
  switch (extension) {
    case ".json":
      return parseJson(source);
    case ".yaml":
    case ".yml":
      return parseSafeYaml(source);
    case ".md":
      return parseMarkdownFrontmatter(source);
    default:
      throw new TypeError("La solicitud debe usar .json, .yaml, .yml o .md");
  }
}

export async function importRequest(
  path: string,
  options: ImportRequestOptions = {},
): Promise<NormalizedRequest> {
  const extension = extname(path);
  const bytes = await readRequestBytes(path);
  const source = normalizeIngestionText(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  const request = normalizeRequestInput(parseInput(extension, source));
  if (
    options.expectedChangeId !== undefined &&
    request.changeId !== options.expectedChangeId
  ) {
    throw new TypeError(
      "La solicitud cambió de identidad durante la recepción",
    );
  }
  if (options.persistRaw !== false) {
    await copyRawRequest(bytes, request, extension, options);
  }
  return request;
}
