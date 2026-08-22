import type { APIRoute } from "astro";

import { buildRobotsPolicy } from "../lib/site/robots.ts";

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(
    new TextEncoder().encode(
      buildRobotsPolicy(process.env.SITE_INDEXABLE === "true"),
    ),
    {
      headers: { "content-type": "text/plain" },
    },
  );
