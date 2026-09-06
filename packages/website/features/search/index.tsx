"use client";

import { createRuntime } from "@wych/react";
import { Effect, Layer } from "effect";
import type MiniSearch from "minisearch";
import { useRouter } from "next/navigation";
import type { SearchRecord } from "@/lib/search-index";
import { Dialog } from "@/components/ui/dialog";
import { docsSearch, SearchEngine } from "./feature";

// ---------------------------------------------------------------------------
// Live engine: minisearch + the index, both loaded on first use
// ---------------------------------------------------------------------------

const LIMIT = 20;

type Engine = MiniSearch<SearchRecord>;

const loadEngine = async (): Promise<Engine> => {
  const [{ default: MiniSearch }, response] = await Promise.all([
    import("minisearch"),
    fetch("/search-index.json"),
  ]);
  if (!response.ok) throw new Error(`search index: ${response.status}`);
  const records = (await response.json()) as SearchRecord[];
  const engine = new MiniSearch<SearchRecord>({
    fields: ["title", "heading", "content"],
    storeFields: ["slug", "section", "title", "heading", "anchor", "content"],
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { title: 3, heading: 2 },
      combineWith: "AND",
    },
  });
  engine.addAll(records);
  return engine;
};

/**
 * One engine per page load. A failed load is forgotten so the next search
 * tries again rather than reporting the same error forever.
 */
let pending: Promise<Engine> | undefined;
const engine = (): Promise<Engine> =>
  (pending ??= loadEngine().catch((error: unknown) => {
    pending = undefined;
    throw error;
  }));

const ready = Effect.tryPromise({
  try: engine,
  catch: (error) => (error instanceof Error ? error : new Error(String(error))),
});

const SearchEngineLive = Layer.succeed(SearchEngine)({
  warm: Effect.ignore(ready),
  search: (query) =>
    Effect.map(ready, (engine) =>
      engine
        .search(query)
        .slice(0, LIMIT)
        .map((result) => ({
          id: String(result.id),
          slug: result.slug as string,
          section: result.section as string,
          title: result.title as string,
          heading: result.heading as string,
          anchor: result.anchor as string,
          content: result.content as string,
          terms: result.terms,
        })),
    ),
});

// ---------------------------------------------------------------------------
// Runtime and the component the trigger loads
// ---------------------------------------------------------------------------

const { component } = createRuntime(SearchEngineLive);

const SearchPanel = component(docsSearch, { name: "DocsSearch" });

export interface SearchDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** The dialog root stays outside the feature: the trigger owns `open`. */
export default function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SearchPanel
        open={open}
        onNavigated={({ href }) => {
          onOpenChange(false);
          router.push(href);
        }}
      />
    </Dialog>
  );
}
