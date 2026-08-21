import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

type ContractScope = "public" | "server";

function staticContractNames(source: string): string[] {
  return [...source.matchAll(/^contractTest\("([^"]+)"/gm)].map(
    (match) => match[1],
  );
}

function sourceBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `No se encontró ${marker}`);
  const end = source.indexOf("]) {", start);
  assert.notEqual(end, -1, `No se pudo cerrar ${marker}`);
  return source.slice(start, end);
}

function quotedValues(block: string): string[] {
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function materializedNames(source: string): string[] {
  const navigation = sourceBlock(source, "for (const [path, currentHref] of [");
  const subsidy = sourceBlock(
    source,
    'for (const path of [\n  "/subvenciones"',
  );
  const approved = sourceBlock(source, 'for (const path of [\n  "/",');
  const remote = sourceBlock(source, "for (const [slug, name, action] of [");

  const navigationPaths = [
    ...navigation.matchAll(/\[\s*"([^"]+)"\s*,\s*"[^"]+"\s*,?\s*\]/g),
  ].map((match) => match[1]);
  const subsidyPaths = quotedValues(subsidy);
  const approvedPaths = quotedValues(approved);
  const remoteSlugs = [
    ...remote.matchAll(/\[\s*"([^"]+)"\s*,\s*"[^"]+"\s*,\s*"[^"]+"\s*\]/g),
  ].map((match) => match[1]);

  return [
    ...staticContractNames(source),
    ...navigationPaths.map(
      (path) => `marks the current navigation destination on ${path}`,
    ),
    ...subsidyPaths.map((path) => `retires the legacy subsidy route ${path}`),
    ...approvedPaths.map(
      (path) => `keeps the approved route ${path} available`,
    ),
    ...remoteSlugs.map((slug) => `renders the ${slug} remote project page`),
  ];
}

function staticContractBodies(source: string): Array<[string, string]> {
  const matches = [
    ...source.matchAll(
      /^contractTest\("([^"]+)",\s*async \(\) => \{([\s\S]*?)(?=^contractTest\(|^for \(|$(?![\s\S]))/gm,
    ),
  ];
  return matches.map((match) => [match[1], match[2]]);
}

test("classifies every materialized original HTML contract exactly once", async () => {
  const root = process.cwd();
  const source = await readFile(
    join(root, "tests/contracts/rendered-html.contract.mjs"),
    "utf8",
  );
  const scopes = JSON.parse(
    await readFile(join(root, "tests/contracts/contract-scope.json"), "utf8"),
  ) as Record<string, ContractScope>;
  const names = materializedNames(source);

  assert.equal(names.length, 79);
  assert.equal(new Set(names).size, 79);
  assert.deepEqual(Object.keys(scopes).sort(), [...names].sort());
  assert.ok(
    Object.values(scopes).every(
      (scope) => scope === "public" || scope === "server",
    ),
  );
  assert.equal(
    Object.values(scopes).filter((scope) => scope === "public").length,
    62,
  );
  assert.equal(
    Object.values(scopes).filter((scope) => scope === "server").length,
    17,
  );

  const serverStatusContracts = staticContractBodies(source)
    .filter(([, body]) =>
      /\.status,\s*(?:308|410)\b|headers\.get\("location"\)/.test(body),
    )
    .map(([name]) => name)
    .sort();
  assert.ok(
    serverStatusContracts.includes(
      "publishes Ontinyent and Escurial as built communities on the waitlist",
    ),
  );
  assert.ok(
    serverStatusContracts.includes(
      "retires the electric-car charger product completely",
    ),
  );
  for (const name of serverStatusContracts) {
    assert.equal(
      scopes[name],
      "server",
      `${name} observa un contrato de servidor`,
    );
  }
});
