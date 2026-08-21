import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import * as blogData from "../../src/content/blog-data.ts";
import * as communityData from "../../src/content/community-data.ts";
import * as eventsData from "../../src/content/events-data.ts";
import * as legalContent from "../../src/content/legal-content.ts";
import * as partnerData from "../../src/content/partner-data.ts";
import * as remoteProjectData from "../../src/content/remote-project-data.ts";
import * as trustData from "../../src/content/trust-data.ts";

interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

interface SourceManifest {
  source: { commit: string };
  assets: ManifestFile[];
  sourceFiles: ManifestFile[];
}

interface ProvenanceEntry {
  sourcePath: string;
  destination: string;
  sourceCommit: string;
  sha256: string;
  bytes: number;
}

interface ContentCopy {
  sourcePath: string;
  destination: string;
}

const copiedContent: readonly ContentCopy[] = [
  {
    sourcePath: "app/community-data.ts",
    destination: "src/content/community-data.ts",
  },
  { sourcePath: "app/blog-data.ts", destination: "src/content/blog-data.ts" },
  {
    sourcePath: "app/remote-project-data.ts",
    destination: "src/content/remote-project-data.ts",
  },
  {
    sourcePath: "app/events-data.ts",
    destination: "src/content/events-data.ts",
  },
  { sourcePath: "app/trust-data.ts", destination: "src/content/trust-data.ts" },
  {
    sourcePath: "app/legal-content.ts",
    destination: "src/content/legal-content.ts",
  },
  {
    sourcePath: "app/socios/partner-data.ts",
    destination: "src/content/partner-data.ts",
  },
  {
    sourcePath: "app/guide-content.md",
    destination: "src/content/guide-content.md",
  },
  { sourcePath: "app/globals.css", destination: "src/styles/reference.css" },
];

const partnerSourcePath = "app/socios/partner-data.ts";
const partnerDestination = "src/content/partner-data.ts";
const partnerAdjustedSha256 =
  "99305b629927aaf9dc9b8de9476b4863f03221c01d241e61d29f579bc7609d79";
const partnerAdjustedBytes = 9282;

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function compareProvenance(
  first: ProvenanceEntry,
  second: ProvenanceEntry,
): number {
  if (first.destination < second.destination) return -1;
  if (first.destination > second.destination) return 1;
  if (first.sourcePath < second.sourcePath) return -1;
  if (first.sourcePath > second.sourcePath) return 1;
  return 0;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function manifestFile(manifest: SourceManifest, path: string): ManifestFile {
  const entry = manifest.sourceFiles.find((file) => file.path === path);
  assert.ok(entry, `Falta ${path} en parity/source-manifest.json`);
  return entry;
}

function matchingProvenance(
  provenance: ProvenanceEntry[],
  destination: string,
): ProvenanceEntry[] {
  return provenance.filter((entry) => entry.destination === destination);
}

async function assertRegularFile(path: string): Promise<Buffer> {
  const details = await lstat(path);
  assert.equal(
    details.isSymbolicLink(),
    false,
    `${path} no puede ser un symlink`,
  );
  assert.equal(details.isFile(), true, `${path} debe ser un archivo regular`);
  return readFile(path);
}

function expectedProvenance(
  source: ManifestFile,
  sourcePath: string,
  destination: string,
  sourceCommit: string,
): ProvenanceEntry {
  return {
    sourcePath,
    destination,
    sourceCommit,
    sha256: source.sha256,
    bytes: source.bytes,
  };
}

test("imports the frozen site datasets with their required cardinalities and exports", () => {
  assert.equal(communityData.communities.length, 20);
  assert.equal(communityData.communityPages.length, 21);
  assert.equal(blogData.blogPosts.length, 19);
  assert.equal(remoteProjectData.remoteProjects.length, 3);

  assert.deepEqual(Object.keys(communityData).sort(), [
    "communities",
    "communityPages",
    "getCommunity",
    "getCommunityDisplayTitle",
    "getNetworkCommunities",
  ]);
  assert.deepEqual(Object.keys(blogData).sort(), [
    "blogCategories",
    "blogPosts",
    "getBlogPost",
  ]);
  assert.deepEqual(Object.keys(remoteProjectData).sort(), [
    "getRemoteProject",
    "remoteProjects",
  ]);
  assert.deepEqual(Object.keys(eventsData).sort(), [
    "eventsLastReviewed",
    "pastEvents",
    "upcomingEvents",
  ]);
  assert.deepEqual(Object.keys(trustData).sort(), [
    "cnmcRegistryUrl",
    "communityVoices",
    "googleReviewHighlights",
    "googleReviewsUrl",
    "legalLinks",
    "pressMentions",
  ]);
  assert.deepEqual(Object.keys(legalContent), ["legalDocuments"]);
  assert.deepEqual(Object.keys(partnerData).sort(), [
    "allianceFacts",
    "documentCategories",
    "executiveSummary",
    "financialMetrics",
    "grantedSubsidies",
    "growthEngines",
    "milestoneAgenda",
    "partnerUpdate",
    "potentialSubsidies",
    "publishedMaterials",
    "roadmapPhases",
    "teamUpdates",
  ]);
});

test("copies every frozen content blob and CSS with deterministic provenance", async () => {
  const root = process.cwd();
  const manifest = await readJson<SourceManifest>(
    join(root, "parity/source-manifest.json"),
  );
  const provenance = await readJson<ProvenanceEntry[]>(
    join(root, "parity/provenance.json"),
  );

  assert.equal(
    manifest.source.commit,
    "68ea294c54dc5e15e20f470fc421a239927565a8",
  );
  assert.deepEqual(provenance, [...provenance].sort(compareProvenance));

  for (const copy of copiedContent) {
    const source = manifestFile(manifest, copy.sourcePath);
    const contents = await assertRegularFile(join(root, copy.destination));
    assert.deepEqual(matchingProvenance(provenance, copy.destination), [
      expectedProvenance(
        source,
        copy.sourcePath,
        copy.destination,
        manifest.source.commit,
      ),
    ]);

    if (copy.sourcePath === partnerSourcePath) {
      assert.equal(contents.byteLength, partnerAdjustedBytes);
      assert.equal(sha256(contents), partnerAdjustedSha256);
      assert.doesNotMatch(contents.toString("utf8"), /server-only/);
    } else {
      assert.equal(contents.byteLength, source.bytes);
      assert.equal(sha256(contents), source.sha256);
    }
  }

  const css = manifestFile(manifest, "app/globals.css");
  assert.equal(
    css.sha256,
    "3a3e6c96604ba3d635cc8dbcb2eaa0639f261f03962da6e88a4c42c58f3e05c8",
  );
  assert.equal(css.bytes, 485081);
});

test("copies every manifest public asset byte-for-byte without symlinks", async () => {
  const root = process.cwd();
  const manifest = await readJson<SourceManifest>(
    join(root, "parity/source-manifest.json"),
  );
  const provenance = await readJson<ProvenanceEntry[]>(
    join(root, "parity/provenance.json"),
  );

  assert.equal(manifest.assets.length, 77);
  for (const asset of manifest.assets) {
    assert.match(asset.path, /^public\//);
    const contents = await assertRegularFile(join(root, asset.path));
    assert.equal(contents.byteLength, asset.bytes, asset.path);
    assert.equal(sha256(contents), asset.sha256, asset.path);
    assert.deepEqual(matchingProvenance(provenance, asset.path), [
      expectedProvenance(asset, asset.path, asset.path, manifest.source.commit),
    ]);
  }
});

test("copied runtime data does not depend on the source checkout or Next-only modules", async () => {
  const root = process.cwd();
  for (const copy of copiedContent.filter(({ destination }) =>
    destination.endsWith(".ts"),
  )) {
    const contents = await readFile(join(root, copy.destination), "utf8");
    assert.doesNotMatch(
      contents,
      /(?:from\s+|import\s*\()["'](?:next|vinext)(?:\/[^"']*)?["']/,
    );
    assert.doesNotMatch(contents, /import\s+["']server-only["']/);
    assert.doesNotMatch(contents, /comunidadsolarweb/);
  }

  const partner = await readFile(join(root, partnerDestination), "utf8");
  assert.doesNotMatch(partner, /server-only/);
});
