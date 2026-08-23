import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  readMigratedSource,
  readProjectAsset,
} from "./read-migrated-source.ts";

test("orders migrated source files by deterministic lexical path", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-source-order-"));
  try {
    const site = join(root, "src", "components", "site");
    await mkdir(site, { recursive: true });
    await writeFile(join(site, "a.astro"), "lowercase");
    await writeFile(join(site, "Z.astro"), "uppercase");

    assert.equal(
      await readMigratedSource("site", root),
      "uppercase\nlowercase",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads the robots route together with its effective policy module", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-robots-source-"));
  try {
    await mkdir(join(root, "src", "pages"), { recursive: true });
    await mkdir(join(root, "src", "lib", "site"), { recursive: true });
    await writeFile(
      join(root, "src", "pages", "robots.txt.ts"),
      "export { buildRobotsPolicy } from '../lib/site/robots.ts';",
    );
    await writeFile(
      join(root, "src", "lib", "site", "robots.ts"),
      'export const excluded = ["/socios"];',
    );

    assert.match(await readMigratedSource("robots", root), /"\/socios"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads regular local assets but rejects an intermediate symlink escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "comunidadsolar-assets-"));
  const outside = join(root, "outside");
  try {
    await mkdir(join(root, "public", "media"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(root, "public", "media", "regular.txt"), "local");
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(root, "public", "escaped"));

    assert.equal(
      (await readProjectAsset("media/regular.txt", root)).toString("utf8"),
      "local",
    );
    await assert.rejects(
      () => readProjectAsset("escaped/secret.txt", root),
      /symlinks|fuera de public/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
