import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { allDocs, findDoc, renderMarkdown } from "@/lib/docs";

/** Every page is known at build time, so the whole section is static. */
export const dynamicParams = false;

export async function generateStaticParams() {
  const docs = await allDocs();
  return docs.map((doc) => ({ slug: doc.slug === "" ? [] : [doc.slug] }));
}

export async function generateMetadata({
  params,
}: PageProps<"/docs/[[...slug]]">): Promise<Metadata> {
  const { slug } = await params;
  const doc = await findDoc(slug?.[0] ?? "");
  if (!doc) return {};
  return { title: `${doc.title} — @wych/react`, description: doc.description };
}

export default async function DocPage({ params }: PageProps<"/docs/[[...slug]]">) {
  const { slug } = await params;
  const doc = await findDoc(slug?.[0] ?? "");
  if (!doc) notFound();

  const html = await renderMarkdown(doc.markdown);

  return (
    <article
      className="prose prose-zinc max-w-none dark:prose-invert prose-headings:tracking-tight prose-pre:border prose-pre:border-black/[.08] prose-pre:bg-zinc-50 dark:prose-pre:border-white/[.145] dark:prose-pre:bg-zinc-950"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
