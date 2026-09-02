import assert from "node:assert/strict";
import { test } from "node:test";

import { blogPosts as frozenBlogPosts } from "../../src/content/blog-data.ts";
import { blogPosts } from "../../src/content/blog-runtime.ts";

test("repairs the corrupt Fuente Álamo image without altering frozen source data", () => {
  const slug = "bautizo-bajo-la-lluvia-en-fuente-alamo";
  const frozenPost = frozenBlogPosts.find((post) => post.slug === slug);
  const runtimePost = blogPosts.find((post) => post.slug === slug);

  assert.equal(frozenPost?.image, "/media/historia-youtube-reqBqJBFQIk.jpg");
  assert.equal(
    runtimePost?.image,
    "/media/historia-fuente-alamo-inauguracion.jpg",
  );
  assert.equal(
    blogPosts.filter((post, index) => post !== frozenBlogPosts[index]).length,
    1,
  );
});
