import { buildSearchIndex } from "@/lib/search-index";

export const dynamic = "force-static";

/**
 * The docs, one record per heading section, for the client-side search
 * dialog. Fetched on first open, never on page load.
 */
export async function GET() {
  return Response.json(await buildSearchIndex());
}
