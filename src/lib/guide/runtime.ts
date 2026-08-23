import { blogPosts } from "../../content/blog-data.ts";
import { communityPages } from "../../content/community-data.ts";
import { remoteProjects } from "../../content/remote-project-data.ts";

export const teamGuideDownloadPath =
  "/guia-equipo-nueva-web-comunidad-solar.md";

export const teamGuideSnapshot = {
  basePages: 21,
  communities: communityPages.length,
  remoteProjects: remoteProjects.length,
  stories: blogPosts.length,
};

export const teamGuideTotalRoutes =
  teamGuideSnapshot.basePages +
  teamGuideSnapshot.communities +
  teamGuideSnapshot.remoteProjects +
  teamGuideSnapshot.stories;

export function hydrateTeamGuideMarkdown(source: string): string {
  const replacements: Record<string, string> = {
    "{{BASE_PAGE_COUNT}}": String(teamGuideSnapshot.basePages),
    "{{COMMUNITY_PAGE_COUNT}}": String(teamGuideSnapshot.communities),
    "{{REMOTE_PROJECT_COUNT}}": String(teamGuideSnapshot.remoteProjects),
    "{{BLOG_STORY_COUNT}}": String(teamGuideSnapshot.stories),
    "{{TOTAL_CONTENT_ROUTES}}": String(teamGuideTotalRoutes),
  };

  return Object.entries(replacements).reduce(
    (content, [token, value]) => content.replaceAll(token, value),
    source,
  );
}
