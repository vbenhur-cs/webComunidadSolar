import assert from "node:assert/strict";
import { test } from "node:test";

import {
  absoluteCanonical,
  completeSiteMeta,
  defaultDescription,
  defaultTitle,
  socialMetadata,
} from "../../../src/lib/seo/metadata.ts";

test("keeps an explicit null description distinct from an absent description", () => {
  assert.equal(completeSiteMeta().description, defaultDescription);
  assert.equal(completeSiteMeta({ description: null }).description, null);
});

test("uses canonical public metadata for social tags without the document title template", () => {
  const metadata = completeSiteMeta({
    title: "Comunidad energética de Villalbilla",
    description: "Energía compartida en Villalbilla.",
    canonical: "/comunidades-energeticas/villalbilla",
  });

  assert.deepEqual(socialMetadata(metadata), {
    title: "Comunidad energética de Villalbilla",
    description: "Energía compartida en Villalbilla.",
    url: absoluteCanonical("/comunidades-energeticas/villalbilla"),
  });
});

test("keeps root social metadata for a canonical-less private page", () => {
  const metadata = completeSiteMeta({
    title: "Área privada",
    description: null,
    canonical: null,
  });

  assert.deepEqual(socialMetadata(metadata), {
    title: defaultTitle,
    description: defaultDescription,
    url: absoluteCanonical("/"),
  });
});
