import { allDocs } from "@/lib/docs";

export const dynamic = "force-static";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://wych.dev";

/**
 * The llms.txt index — https://llmstxt.org. One line per page, so an agent can
 * fetch only what it needs. The whole corpus is at /llms-full.txt.
 */
export async function GET() {
  const docs = await allDocs();
  const [index, ...rest] = docs;

  const body = [
    "# @wych/react",
    "",
    `> ${index?.description ?? "A TEA-style feature runtime for React, built on Effect."}`,
    "",
    "These docs also ship inside the npm package, at `node_modules/@wych/react/docs`.",
    "",
    "## Docs",
    "",
    ...rest.map((doc) => `- [${doc.title}](${SITE}/docs/${doc.slug}): ${doc.description}`),
    "",
    "## Full text",
    "",
    `- [All pages, concatenated](${SITE}/llms-full.txt)`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
