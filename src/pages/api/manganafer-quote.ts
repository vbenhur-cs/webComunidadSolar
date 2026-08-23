import type { APIContext } from "astro";
import { env } from "cloudflare:workers";

import { handleQuoteRequest } from "../../lib/manganafer/quote.ts";
import { selectManganaferQuoteEnvironment } from "../../lib/manganafer/quote-config.ts";

export const prerender = false;

export function POST({ request }: APIContext): Promise<Response> {
  return handleQuoteRequest(request, {
    env: selectManganaferQuoteEnvironment(env),
    fetcher: fetch,
  });
}
