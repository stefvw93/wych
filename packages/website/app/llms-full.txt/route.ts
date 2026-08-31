import { allDocs } from "@/lib/docs";

export const dynamic = "force-static";

/** Every page as one plain-text document, in nav order. */
export async function GET() {
  const docs = await allDocs();

  const body = docs.map((doc) => `${doc.markdown}\n`).join("\n---\n\n");

  return new Response(`# @wych/react\n\n${body}`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
