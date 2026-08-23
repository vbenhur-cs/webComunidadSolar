import type { APIContext } from "astro";
import { env } from "cloudflare:workers";

import guideSource from "../content/guide-content.md?raw";
import { readIdentity } from "../lib/auth/identity.ts";
import { readAccessEnv } from "../lib/auth/private-area.ts";
import { teamGuideMarkdownResponse } from "../lib/guide/markdown.ts";

export const prerender = false;

export function GET({ request }: APIContext): Response {
  return teamGuideMarkdownResponse({
    request,
    identity: readIdentity(request.headers),
    env: readAccessEnv(env as unknown as Record<string, unknown>),
    source: guideSource,
  });
}
