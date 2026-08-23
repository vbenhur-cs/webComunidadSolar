const knownSecretPatterns = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/iu,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bAIza[0-9A-Za-z_-]{20,}\b/u,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*(?:["'][^"'`\r\n]+["']|[^\s'"`]+)/iu,
];

/** Rejects supplied text that looks like a credential before it can be archived. */
export function assertNoSuppliedSecrets(source: string): void {
  if (knownSecretPatterns.some((pattern) => pattern.test(source))) {
    throw new TypeError("El paquete aportado contiene un secreto o token");
  }
}

/**
 * Scans every supplied byte sequence as Latin-1 so ASCII credential prefixes
 * cannot hide inside an otherwise valid binary asset.
 */
export function assertNoSuppliedSecretsBytes(bytes: Uint8Array): void {
  assertNoSuppliedSecrets(Buffer.from(bytes).toString("latin1"));
}
