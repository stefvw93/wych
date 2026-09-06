"use client";

import { Action, Command, define, Task } from "@wych/react";
import { Context, Effect, Schema } from "effect";
import { DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Engine service. The live layer is in ./index.tsx; a test supplies a stub.
// ---------------------------------------------------------------------------

export const Hit = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  section: Schema.String,
  title: Schema.String,
  heading: Schema.String,
  anchor: Schema.String,
  content: Schema.String,
  /** Index terms that matched, for the excerpt. */
  terms: Schema.Array(Schema.String),
});
export type Hit = typeof Hit.Type;
export const Hits = Schema.Array(Hit);

export class SearchEngine extends Context.Service<
  SearchEngine,
  {
    /** Load the library and the index; a no-op once loaded. */
    readonly warm: Effect.Effect<void>;
    readonly search: (query: string) => Effect.Effect<ReadonlyArray<Hit>, Error>;
  }
>()("SearchEngine") {}

// ---------------------------------------------------------------------------
// Feature. Pure: no fetch, no library, no router. See feature.test.ts.
// ---------------------------------------------------------------------------

export const Typed = Action("Typed", { query: Schema.String });
export const Moved = Action("Moved", { delta: Schema.Number });
export const Submitted = Action("Submitted", {});
export const Reset = Action("Reset", {});
export const Navigated = Action.output("Navigated", { href: Schema.String });

// Take latest: a new Typed interrupts the search still running for the old one.
// The wait is the search's own, so it lives in `run`.
const search = Task("Search", {
  success: Hits,
  onError: Task.message,
  run: (query: string) =>
    Effect.gen(function* () {
      yield* Effect.sleep("150 millis");
      const engine = yield* SearchEngine;
      return yield* engine.search(query);
    }),
});

const warm = Command.keyed(
  "warm",
  Command.effect(() =>
    Effect.gen(function* () {
      const engine = yield* SearchEngine;
      yield* engine.warm;
    }),
  ),
);

const State = Schema.Struct({
  query: Schema.String,
  results: Task.schema(Hits),
  selected: Schema.Number,
});
export type State = typeof State.Type;

const DocsSearch = define({
  props: Schema.Struct({ open: Schema.Boolean }),
  state: State,
  action: Action.of([Typed, Moved, Submitted, Reset, ...search.actions]),
  output: Action.of([Navigated]),
});

export const initial: State = { query: "", results: Task.idle, selected: 0 };

export const hrefOf = (hit: Hit): string =>
  `${hit.slug === "" ? "/docs" : `/docs/${hit.slug}`}${hit.anchor === "" ? "" : `#${hit.anchor}`}`;

export const docsSearch = DocsSearch.create({
  initialState: () => initial,
  reducer: {
    Mounted: (_payload, { state }) => [state, warm],
    PropsChanged: ({ previous }, { state, props }) => {
      if (props.open && !previous.open) return [state, warm];
      if (!props.open && previous.open) return [initial, search.cancel];
      return state;
    },
    Typed: ({ query }, { state }) =>
      query.trim() === ""
        ? [{ ...state, query, results: Task.idle, selected: 0 }, search.cancel]
        : Task.start({ ...state, query, selected: 0 }, "results", search.run(query)),
    SearchResolved: ({ value }, { state }) => ({ ...state, results: Task.resolved(value) }),
    SearchRejected: ({ error }, { state }) => ({ ...state, results: Task.rejected(error) }),
    Moved: ({ delta }, { state }) => {
      const count = Task.getOrElse(state.results, () => []).length;
      if (count === 0) return state;
      return { ...state, selected: (state.selected + delta + count) % count };
    },
    Submitted: (_payload, { state }) => {
      const hit = Task.getOrElse(state.results, () => [])[state.selected];
      return hit === undefined ? state : [state, Command.output(Navigated, { href: hrefOf(hit) })];
    },
    Reset: () => [initial, search.cancel],
  },
  render: ({ state, dispatch }) => (
    <DialogContent
      showCloseButton={false}
      className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
      aria-describedby={undefined}
    >
      <DialogTitle className="sr-only">Search docs</DialogTitle>
      <div className="border-b p-2">
        <Input
          autoFocus
          type="search"
          role="combobox"
          aria-expanded={Task.isResolved(state.results)}
          aria-controls="docs-search-results"
          aria-autocomplete="list"
          placeholder="Search the docs"
          value={state.query}
          onChange={(event) => dispatch(Typed.make({ query: event.target.value }))}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              dispatch(Moved.make({ delta: 1 }));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              dispatch(Moved.make({ delta: -1 }));
            } else if (event.key === "Enter") {
              event.preventDefault();
              dispatch(Submitted.make({}));
            }
          }}
          className="h-9 border-0 text-sm focus-visible:ring-0 md:text-sm"
        />
      </div>
      <div id="docs-search-results" className="max-h-[60vh] overflow-y-auto">
        {Task.match(state.results, {
          Idle: () => <Hint>Type to search. Headings and prose, every page.</Hint>,
          Pending: () => <Hint>Searching</Hint>,
          Rejected: ({ error }) => <Hint>{error}</Hint>,
          Resolved: ({ value }) =>
            value.length === 0 ? (
              <Hint>No results for &ldquo;{state.query}&rdquo;</Hint>
            ) : (
              <ul role="listbox" className="py-1">
                {value.map((hit, index) => {
                  const href = hrefOf(hit);
                  const selected = index === state.selected;
                  return (
                    <li
                      key={hit.id}
                      role="option"
                      aria-selected={selected}
                      ref={selected ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                      className={cn(
                        "border-l-2 border-transparent",
                        selected && "border-primary bg-accent text-accent-foreground",
                      )}
                    >
                      <a
                        href={href}
                        className="block px-3 py-2 outline-none"
                        onClick={(event) => {
                          if (
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.button !== 0
                          )
                            return;
                          event.preventDefault();
                          dispatch(Navigated.make({ href }));
                        }}
                      >
                        <div className="flex items-baseline gap-2 text-[11px] text-muted-foreground">
                          {hit.section === "" ? null : <span>{hit.section}</span>}
                          <span>{hit.title}</span>
                        </div>
                        <div className="font-medium">{hit.heading}</div>
                        <Excerpt content={hit.content} terms={hit.terms} />
                      </a>
                    </li>
                  );
                })}
              </ul>
            ),
        })}
      </div>
      <div className="flex gap-3 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate
        </span>
        <span>
          <Kbd>↵</Kbd> open
        </span>
        <span>
          <Kbd>esc</Kbd> close
        </span>
      </div>
    </DialogContent>
  ),
});

const Hint = ({ children }: { readonly children: React.ReactNode }) => (
  <p className="px-3 py-6 text-center text-muted-foreground">{children}</p>
);

const Kbd = ({ children }: { readonly children: React.ReactNode }) => (
  <kbd className="rounded-none border bg-muted px-1 font-mono">{children}</kbd>
);

const WINDOW = 70;

/** The content around the first matched term, clipped to a short window. */
const Excerpt = ({
  content,
  terms,
}: {
  readonly content: string;
  readonly terms: ReadonlyArray<string>;
}) => {
  if (content === "") return null;
  const lower = content.toLowerCase();
  let at = -1;
  let length = 0;
  for (const term of terms) {
    const i = lower.indexOf(term.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) {
      at = i;
      length = term.length;
    }
  }
  if (at === -1) {
    return <p className="truncate text-muted-foreground">{content.slice(0, WINDOW * 2)}</p>;
  }
  const start = Math.max(0, at - WINDOW);
  const end = Math.min(content.length, at + length + WINDOW);
  return (
    <p className="truncate text-muted-foreground">
      {start > 0 ? "…" : ""}
      {content.slice(start, at)}
      <mark className="bg-transparent font-medium text-foreground">
        {content.slice(at, at + length)}
      </mark>
      {content.slice(at + length, end)}
      {end < content.length ? "…" : ""}
    </p>
  );
};
