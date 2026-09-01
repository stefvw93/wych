import { ArrowLeftIcon, ArrowRightIcon } from "@phosphor-icons/react/ssr";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SECTIONS, allDocs, renderMarkdown } from "@/lib/docs";

/** Every page is known at build time, so the whole section is static. */
export const dynamicParams = false;

export async function generateStaticParams() {
  const docs = await allDocs();
  return docs.map((doc) => ({ slug: doc.slug === "" ? [] : doc.slug.split("/") }));
}

export async function generateMetadata({
  params,
}: PageProps<"/docs/[[...slug]]">): Promise<Metadata> {
  const { slug } = await params;
  const doc = (await allDocs()).find((d) => d.slug === (slug?.join("/") ?? ""));
  if (!doc) return {};
  return { title: doc.title, description: doc.description };
}

export default async function DocPage({ params }: PageProps<"/docs/[[...slug]]">) {
  const { slug } = await params;
  const docs = await allDocs();
  const index = docs.findIndex((d) => d.slug === (slug?.join("/") ?? ""));
  const doc = docs[index];
  if (!doc) notFound();

  const html = await renderMarkdown(doc.markdown);
  const section = SECTIONS.find((s) => s.dir === doc.section);
  const prev = docs[index - 1];
  const next = docs[index + 1];

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            {doc.slug === "" ? (
              <BreadcrumbPage>Docs</BreadcrumbPage>
            ) : (
              <BreadcrumbLink render={<Link href="/docs" />}>Docs</BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {section && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>{section.title}</BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{doc.title}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>

      <article
        className="prose prose-neutral max-w-none dark:prose-invert prose-headings:font-heading prose-headings:tracking-tight prose-a:text-foreground prose-a:underline-offset-4 prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-none prose-pre:border prose-pre:border-border prose-pre:bg-muted prose-pre:text-foreground"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <Separator />

      <nav aria-label="Pagination" className="flex justify-between gap-4">
        {prev ? (
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href={`/docs/${prev.slug}`} />}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            {prev.title}
          </Button>
        ) : (
          <span />
        )}
        {next && (
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href={`/docs/${next.slug}`} />}
          >
            {next.title}
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        )}
      </nav>
    </div>
  );
}
