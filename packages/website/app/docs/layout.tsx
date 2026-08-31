import Link from "next/link";
import { allDocs } from "@/lib/docs";

export default async function DocsLayout({ children }: LayoutProps<"/docs">) {
  const docs = await allDocs();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-12 px-6 py-12 md:flex-row md:py-20">
      <nav className="md:w-56 md:shrink-0">
        <Link
          href="/docs"
          className="font-mono text-sm font-medium text-zinc-950 dark:text-zinc-50"
        >
          @wych/react
        </Link>
        <ul className="mt-6 flex flex-col gap-1 text-sm">
          {docs.map((doc) => (
            <li key={doc.slug}>
              <Link
                href={doc.slug === "" ? "/docs" : `/docs/${doc.slug}`}
                className="-mx-2 block rounded px-2 py-1 text-zinc-600 transition-colors hover:bg-black/[.04] hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-white/[.06] dark:hover:text-zinc-50"
              >
                {doc.title}
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-8 text-xs leading-5 text-zinc-500">
          These pages ship with the package. See{" "}
          <Link href="/docs/llm-usage" className="underline underline-offset-2">
            using with AI agents
          </Link>
          .
        </p>
      </nav>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
