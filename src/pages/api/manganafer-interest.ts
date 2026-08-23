import type { APIContext } from "astro";
import { env } from "cloudflare:workers";

import { persistManganaferInterest } from "../../lib/db/client.ts";
import { ensureManganaferInterestStorage } from "../../lib/db/migrations.ts";
import { handleInterestRequest } from "../../lib/manganafer/interest.ts";

export const prerender = false;

export function POST({ request }: APIContext): Promise<Response> {
  return handleInterestRequest(request, {
    db: env.DB,
    ensureStorage: ensureManganaferInterestStorage,
    persistInterest: persistManganaferInterest,
  });
}
