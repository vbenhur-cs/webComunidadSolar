import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("loads the Task 6 focal islands only when their rendered region is visible", async () => {
  const [about, remote, blog] = await Promise.all([
    readFile(join(root, "src/components/pages/about/AboutPage.astro"), "utf8"),
    readFile(
      join(root, "src/components/pages/remote/RemotePage.astro"),
      "utf8",
    ),
    readFile(join(root, "src/components/pages/blog/BlogPage.astro"), "utf8"),
  ]);

  assert.match(about, /<AboutVideo client:visible\s*\/>/);
  assert.equal(remote.match(/<RemoteVideo\s+client:visible/g)?.length, 3);
  assert.match(blog, /<BlogFilter client:visible\s*\/>/);
  assert.doesNotMatch(`${about}\n${remote}\n${blog}`, /client:load/);
});
