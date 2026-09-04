import { ArrowRightIcon, GithubLogoIcon } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { OpenInStackBlitz } from "@/components/open-in-stackblitz";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyCode } from "@/components/copy-code";
import { docsBySection, renderMarkdown } from "@/lib/docs";
import { loadExample } from "@/lib/examples";
import { site } from "@/lib/site";

/**
 * The hero pair. Both files are trimmed copies of
 * `docs/examples/search-debounce/src/search.tsx` and `search.test.ts`; the
 * "Open in StackBlitz" button below them opens the full example.
 */
const FEATURE = `import { Action, createRuntime, define, Task } from "@wych/react";
import { Context, Effect, Layer, Schema } from "effect";

const Hits = Schema.Array(Schema.String);

export class SearchApi extends Context.Service<
  SearchApi,
  { readonly hits: (query: string) => Effect.Effect<ReadonlyArray<string>> }
>()("SearchApi") {}

export const Typed = Action("Typed", { query: Schema.String });
const Cleared = Action("Cleared", {});

// Two actions (SearchResolved, SearchRejected) and one cancellable command.
const search = Task("Search", {
  success: Hits,
  onError: Task.message,
  run: (query: string) => Effect.flatMap(SearchApi, (api) => api.hits(query)),
});

export const taskSearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String, results: Task.schema(Hits) }),
  action: Action.of([Typed, Cleared, ...search.actions]),
}).create({
  initialState: () => ({ query: "", results: Task.idle }),
  reducer: {
    // Take latest: a new Typed interrupts the fiber still resolving the old one.
    Typed: ({ query }, { state }) =>
      Task.start({ ...state, query }, "results", search.run(query)),
    Cleared: (_payload, { state }) =>
      [{ ...state, query: "", results: Task.idle }, search.cancel],
    SearchResolved: ({ value }, { state }) =>
      ({ ...state, results: Task.resolved(value) }),
    SearchRejected: ({ error }, { state }) =>
      ({ ...state, results: Task.rejected(error) }),
  },
  render: ({ state, dispatch }) => (
    <div>
      <input
        value={state.query}
        onChange={(e) => dispatch(Typed.make({ query: e.target.value }))}
      />
      {Task.match(state.results, {
        Idle: () => null,
        Pending: () => <p>Searching</p>,
        Rejected: ({ error }) => <p>{error}</p>,
        Resolved: ({ value }) => <ul>{value.map((h) => <li key={h}>{h}</li>)}</ul>,
      })}
    </div>
  ),
});

const live = Layer.succeed(SearchApi)({
  hits: (query) => Effect.succeed([\`\${query} result\`]),
});
const { component } = createRuntime(live);
export const Search = component(taskSearch, { name: "Search" });`;

const TEST = `import { Effect, Layer } from "effect";
import { expect, test } from "vitest";
import { SearchApi, taskSearch, Typed } from "./search";

// Slow enough that "a" is still in flight when "ab" arrives.
const slowApi = Layer.succeed(SearchApi)({
  hits: (query) => Effect.sleep("50 millis").pipe(Effect.as([\`\${query}!\`])),
});

test("a newer keystroke interrupts the request in flight", async () => {
  const { state, emitted } = await Effect.runPromise(
    taskSearch.run([Typed.make({ query: "a" }), Typed.make({ query: "ab" })], {
      props: {},
      hooks: {},
      layer: slowApi,
    }),
  );

  expect(emitted).toEqual([{ _tag: "SearchResolved", value: ["ab!"] }]);
  expect(state.results).toEqual({ _tag: "Resolved", value: ["ab!"] });
});`;

const PILLARS = [
  {
    title: "Lifecycle without useEffect",
    body: (
      <>
        <code>Mounted</code>, <code>PropsChanged</code>, <code>Unmounted</code> and{" "}
        <code>Error</code> arrive in the reducer like any other action. Startup work, a resubscribe
        when a prop changes, a flush on exit: each is a handler returning{" "}
        <code>[state, command]</code>. No dependency array, no cleanup closure.
      </>
    ),
  },
  {
    title: "Fibers have names",
    body: (
      <>
        The only leaf of a <code>Command</code> is an Effect. Book it under a key and any later
        handler can cancel or restart it by that name. That is the runtime&rsquo;s one supervisory
        concept. Debounce, throttle and retry are the Effect combinators you already have.
      </>
    ),
  },
  {
    title: "A feature is a value",
    body: (
      <>
        <code>reduce</code> folds one action. <code>run</code> folds a sequence to its end against a{" "}
        <code>Layer</code> and reports state, emissions and outputs. <code>component</code> mounts
        the same value in React. <code>renderToString</code> paints initial state and folds nothing.
      </>
    ),
  },
] as const;

const AGENT_POINTS = [
  {
    title: "The definition is the spec",
    body: (
      <>
        <code>define(&#123; props, state, action, output &#125;)</code> is a feature&rsquo;s whole
        contract on one screen: what comes in, what it holds, what it can do, what it tells its
        parent. No <code>useEffect</code> graph to reconstruct, no state hiding in closures.
      </>
    ),
  },
  {
    title: "Wrong is a type error",
    body: (
      <>
        Schemas type props, state and payloads. The reducer needs one handler per action tag,
        required and exhaustive. Outputs are required <code>on&lt;Tag&gt;</code> props at every JSX
        call site. An agent&rsquo;s mistake fails <code>tsc</code> before it reaches a user.
      </>
    ),
  },
  {
    title: "It can check its own work",
    body: (
      <>
        <code>run</code> folds a feature to its end in Node against a test <code>Layer</code>, so an
        agent verifies async logic without a browser. The docs ship inside the package and at{" "}
        <code>/llms.txt</code>, so it reads the version you installed.
      </>
    ),
  },
] as const;

const SECTION_BLURBS: Record<string, string> = {
  Tutorial:
    "One app in three chapters: a feature, then async work, then a parent that hears its children.",
  "How-to":
    "Recipes: debounce, streams, tests with no DOM, TanStack Query, server rendering, devtools.",
  Reference: "Every export, one page per area, with its contract and a snippet that calls it.",
  Explanation: "Why the reducer returns work instead of doing it.",
};

/** A code pane in the hero pair: a file-name caption over a highlighted block. */
function Pane({ file, note, html }: { file: string; note: string; html: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-3 border border-b-0 border-border bg-muted px-4 py-2">
        <span className="font-mono text-xs text-foreground">{file}</span>
        <span className="text-xs text-muted-foreground">{note}</span>
      </div>
      <div
        className="prose prose-neutral min-w-0 max-w-none dark:prose-invert prose-pre:my-0 prose-pre:rounded-none prose-pre:border prose-pre:border-border prose-pre:bg-card prose-pre:text-xs prose-pre:leading-6 prose-pre:text-foreground"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

export default async function Home() {
  const [sections, feature, test, example] = await Promise.all([
    docsBySection(),
    renderMarkdown(`\`\`\`tsx\n${FEATURE}\n\`\`\``).then((r) => r.html),
    renderMarkdown(`\`\`\`ts\n${TEST}\n\`\`\``).then((r) => r.html),
    loadExample("search-debounce", {
      title: "Debounce and take latest",
      description: "A search box with take-latest, and the test that proves it without a DOM.",
    }),
  ]);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-20 px-6 py-16 md:py-24">
        <section className="flex flex-col items-start gap-6">
          <Badge variant="outline">Effect v4 · React 19</Badge>
          <h1 className="max-w-4xl text-3xl font-medium tracking-tight text-balance sm:text-4xl md:text-5xl">
            {/* One sentence per line; the tagline is one sentence today. */}
            {site.tagline.split(/(?<=\.)\s+/).map((sentence) => (
              <span key={sentence} className="block">
                {sentence}
              </span>
            ))}
          </h1>
          <p className="max-w-prose text-lg leading-8 text-muted-foreground">{site.subline}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              nativeButton={false}
              render={<Link href="/docs/tutorial/your-first-feature" />}
            >
              Start the tutorial
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              nativeButton={false}
              render={<a href={site.github} target="_blank" rel="noreferrer" />}
            >
              <GithubLogoIcon data-icon="inline-start" />
              GitHub
            </Button>
          </div>
          <pre className="w-full max-w-prose overflow-x-auto border bg-muted px-4 py-3 font-mono text-xs text-foreground">
            <code>{site.install}</code>
          </pre>
        </section>

        <section className="flex flex-col gap-4">
          {/* Explicit `minmax(0, 1fr)` tracks: an implicit `auto` track grows to
              the widest code line and the page scrolls sideways on phones. */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <CopyCode />
            <Pane file="search.tsx" note="the feature" html={feature} />
            <div className="flex min-w-0 flex-col gap-4">
              <Pane file="search.test.ts" note="the proof: no renderer, no mocks" html={test} />
              <p className="max-w-prose text-sm leading-6 text-muted-foreground">
                Two keystrokes, one slow API, one result. <code>run</code> seeds the actions, runs
                every command against the layer, folds what they dispatch, and resolves when nothing
                is left running. The same feature, unchanged, is a React component.
              </p>
              <div>
                <OpenInStackBlitz example={example} />
              </div>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex max-w-prose flex-col gap-3 text-base leading-7 text-muted-foreground">
            <p>Wych is not a store, not atoms, and not a server cache. It sits next to those.</p>
            <p>
              See{" "}
              <Link
                href="/docs/how-to/use-with-the-react-ecosystem"
                className="underline underline-offset-4"
              >
                use with the React ecosystem
              </Link>{" "}
              (TanStack Query, routers, stores) and{" "}
              <Link href="/docs/explanation/comparisons" className="underline underline-offset-4">
                how it compares
              </Link>
              .
            </p>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          {PILLARS.map((pillar) => (
            <Card key={pillar.title}>
              <CardHeader>
                <CardTitle>{pillar.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm leading-6 text-muted-foreground [&_code]:font-mono [&_code]:text-xs [&_code]:text-foreground">
                {pillar.body}
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-medium tracking-tight">
              Written by agents, checked by the compiler
            </h2>
            <p className="max-w-prose text-base leading-7 text-muted-foreground">
              A coding agent gets the same deal you do: a small typed surface that reads as a spec,
              and a proof that runs with no browser.{" "}
              <Link href="/docs/how-to/use-with-ai-agents" className="underline underline-offset-4">
                Use with AI agents
              </Link>
              .
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {AGENT_POINTS.map((point) => (
              <Card key={point.title}>
                <CardHeader>
                  <CardTitle>{point.title}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm leading-6 text-muted-foreground [&_code]:font-mono [&_code]:text-xs [&_code]:text-foreground">
                  {point.body}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-6">
          <div className="flex items-end justify-between gap-4">
            <h2 className="text-xl font-medium tracking-tight">Documentation</h2>
            <Button variant="link" nativeButton={false} render={<Link href="/docs" />}>
              All pages
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {sections.map((section) => (
              <Card key={section.dir}>
                <CardHeader>
                  <CardTitle>{section.title}</CardTitle>
                  <CardDescription>{SECTION_BLURBS[section.title]}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="flex flex-col gap-1.5">
                    {section.docs.map((doc) => (
                      <li key={doc.slug}>
                        <Link
                          href={`/docs/${doc.slug}`}
                          className="text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                        >
                          {doc.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      </main>
      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-6 text-xs text-muted-foreground">
          <span>
            <span className="font-heading">{site.name}</span>
            <span className="ml-3">wych, as in wych elm.</span>
          </span>
          <div className="flex gap-4">
            <a href={site.npm} className="hover:text-foreground" target="_blank" rel="noreferrer">
              npm
            </a>
            <a
              href={site.github}
              className="hover:text-foreground"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
            <Link href="/llms.txt" className="hover:text-foreground">
              llms.txt
            </Link>
          </div>
        </div>
      </footer>
    </>
  );
}
