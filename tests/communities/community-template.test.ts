import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  communityPages,
  getCommunity,
} from "../../src/content/community-data.ts";
import {
  communityDetailStaticPaths,
  communityCoverageDto,
  selectCommunityTemplate,
} from "../../src/components/pages/communities/community-template.ts";

test("selects the source template and static path for every published community", () => {
  const selected = communityPages.map(selectCommunityTemplate);
  const staticSlugs = communityDetailStaticPaths.map(
    (path) => path.params.community,
  );

  assert.equal(selected.length, 21);
  assert.deepEqual([...new Set(selected)].sort(), ["local", "network"]);
  assert.deepEqual(
    [...staticSlugs].sort(),
    communityPages.map((community) => community.slug).sort(),
  );
  assert.equal(
    selectCommunityTemplate(getCommunity("extremadura")!),
    "network",
  );
  assert.equal(selectCommunityTemplate(getCommunity("villalbilla")!), "local");
});

test("serializes only the coverage DTO for a community island", () => {
  const dto = communityCoverageDto(getCommunity("villalbilla")!);

  assert.deepEqual(Object.keys(dto).sort(), [
    "commercialStatus",
    "map",
    "name",
    "province",
    "slug",
    "status",
    "summary",
  ]);
  assert.equal(dto.slug, "villalbilla");
  assert.equal("installations" in dto, false);
  assert.equal("milestones" in dto, false);
});

test("keeps the isolated legacy template source-defined", async () => {
  const legacyTemplate = await readFile(
    new URL(
      "../../src/components/pages/communities/LegacyCommunity.astro",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(legacyTemplate, /<main>/);
  assert.match(legacyTemplate, /<CoverageFinder compact\s*\/>/);
  assert.doesNotMatch(legacyTemplate, /LocalCommunity|communityCoverageDto/);
});

test("ships only coverage DTOs to the interactive catalogue island", async () => {
  const [coverageFinder, catalogue] = await Promise.all([
    readFile(
      new URL(
        "../../src/components/islands/CoverageFinder.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../src/components/pages/communities/CommunitiesPage.astro",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(coverageFinder, /import type\s*\{\s*Community\s*\}/);
  assert.doesNotMatch(coverageFinder, /communities as sourceCommunities/);
  assert.match(coverageFinder, /function CompactCoverageFinder/);
  assert.match(coverageFinder, /function FullCoverageFinder/);
  assert.match(
    catalogue,
    /const coverageCommunities = communities\.map\(communityCoverageDto\);/,
  );
  assert.match(
    catalogue,
    /<CoverageFinder client:load communities=\{coverageCommunities\} \/>/,
  );
});
