import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const frozenAssertionCount = 709;
const frozenAssertionFingerprint =
  "3ea6fe1c75b0af51c378991b048969d6cdf21df8c21387b6e03b32865d135722";

function assertionCalls(source: string): string[] {
  const file = ts.createSourceFile(
    "rendered-html.contract.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const calls: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "assert"
    ) {
      calls.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return calls;
}

test("preserves every frozen rendered HTML assertion without reading the source checkout", async () => {
  const source = await readFile(
    join(process.cwd(), "tests/contracts/rendered-html.contract.mjs"),
    "utf8",
  );
  const assertions = assertionCalls(source);

  assert.equal(assertions.length, frozenAssertionCount);
  assert.equal(
    createHash("sha256").update(JSON.stringify(assertions)).digest("hex"),
    frozenAssertionFingerprint,
  );
});
