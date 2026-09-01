import { ArrowLeftIcon, ArrowRightIcon, PencilSimpleIcon } from "@phosphor-icons/react/ssr";
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
import { Separator } from "@/components/ui/separator";
import { CopyCode } from "@/components/copy-code";
import { OpenInStackBlitz } from "@/components/open-in-stackblitz";
import { Toc } from "@/components/toc";
import { SECTIONS, allDocs, renderMarkdown } from "@/lib/docs";
import { loadExample } from "@/lib/examples";
import { site } from "@/lib/site";

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

  const { html, headings } = await renderMarkdown(doc.markdown);
  const section = SECTIONS.find((s) => s.dir === doc.section);
  const prev = docs[index - 1];
  const next = docs[index + 1];
  // The page's runnable project, when it has one. A missing directory fails
  // the build rather than dropping the button.
  const example = doc.example === undefined ? undefined : await loadExample(doc.example, doc);

  const editUrl = `${site.github}/edit/main/packages/react/docs/${doc.file}`;

  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,48rem)_13rem] xl:gap-12">
      <div className="flex min-w-0 flex-col gap-8">
        {example && (
          // Sticks below the 3rem header for the whole article. From `md` up
          // it is zero-height so it costs no layout; narrower, it keeps its
          // height so the breadcrumb starts below it instead of under it.
          <div className="sticky top-14 z-10 flex justify-end md:-mb-8 md:h-0">
            <OpenInStackBlitz example={example} />
          </div>
        )}
        <div className="flex min-h-7 flex-wrap items-center gap-4">
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
                  <BreadcrumbItem>
                    {/* The index lists each section under a heading of the same name. */}
                    <BreadcrumbLink render={<Link href={`/docs#${section.dir}`} />}>
                      {section.title}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{doc.title}</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        <article
          className="prose prose-neutral max-w-none dark:prose-invert prose-headings:font-heading prose-headings:tracking-tight prose-a:text-foreground prose-a:underline-offset-4 prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-none prose-pre:border prose-pre:border-border prose-pre:bg-muted prose-pre:text-foreground"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <CopyCode />

        <a
          href={editUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <PencilSimpleIcon className="size-4" />
          Edit this page on GitHub
        </a>

        <Separator />

        <nav aria-label="Pagination" className="grid gap-4 sm:grid-cols-2">
          {prev ? (
            <PageLink href={`/docs/${prev.slug}`} label="Previous" title={prev.title} side="prev" />
          ) : (
            <span />
          )}
          {next && (
            <PageLink href={`/docs/${next.slug}`} label="Next" title={next.title} side="next" />
          )}
        </nav>
      </div>

      <aside className="hidden xl:block">
        <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto">
          <Toc headings={headings} />
        </div>
      </aside>
    </div>
  );
}

function PageLink({
  href,
  label,
  title,
  side,
}: {
  readonly href: string;
  readonly label: string;
  readonly title: string;
  readonly side: "prev" | "next";
}) {
  const Icon = side === "prev" ? ArrowLeftIcon : ArrowRightIcon;
  return (
    <Link
      href={href}
      className={`group flex flex-col gap-1 border border-border px-4 py-3 transition-colors hover:bg-muted ${
        side === "next" ? "items-end text-right sm:col-start-2" : "items-start"
      }`}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="inline-flex items-center gap-1.5 font-heading text-sm font-medium">
        {side === "prev" && (
          <Icon className="size-4 transition-transform group-hover:-translate-x-0.5" />
        )}
        {title}
        {side === "next" && (
          <Icon className="size-4 transition-transform group-hover:translate-x-0.5" />
        )}
      </span>
    </Link>
  );
}
