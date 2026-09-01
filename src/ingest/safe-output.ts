const forbiddenField =
  /api[_-]?key|env(?:ironment)?|argv|args?|argument|pid|bundle|repository|repo|internal|capability|path|ruta|root|cwd|workspace|secret|token|password|credential|intake|stdout|stderr|stack/iu;
const forbiddenValue =
  /api[_ -]?key|codex_executable|env(?:ironment)?|argv|args?|argument|pid|bundle|repository|repo|internal|capability|path|ruta|root|cwd|workspace|secret|token|password|credential|private[ _-]?key|authorization|bearer|set[ _-]?cookie|cookie/iu;
const absolutePath = /file:\/\/|[A-Za-z]:[\\/]|\/\S*/u;

function safeString(value: string): string {
  if (forbiddenValue.test(value) || absolutePath.test(value)) {
    return "[redactado]";
  }
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127)
      ? " "
      : character;
  })
    .join("")
    .slice(0, 240);
}

/**
 * Produces a deliberately small, path-free representation for CLI and script
 * output.  Field names that can carry execution authority are omitted rather
 * than recursively redacted, so nested process/environment objects cannot
 * accidentally acquire a printable shape.
 */
export function safeJson(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return safeString(value);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return "[redactado]";
  }
  if (typeof value === "function" || typeof value !== "object") {
    return "[redactado]";
  }
  if (seen.has(value)) return "[redactado]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => safeJson(entry, seen));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenField.test(key)) continue;
    result[key] = safeJson(entry, seen);
  }
  return result;
}

/** Never serialize an Error object, its stack, or a sensitive message value. */
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "fallo operativo";
  const safe = safeString(message);
  return safe === "[redactado]" || safe === "" ? "fallo operativo" : safe;
}
