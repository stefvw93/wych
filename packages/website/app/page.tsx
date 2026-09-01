import { ArrowRightIcon, GithubLogoIcon } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { docsBySection, renderMarkdown } from "@/lib/docs";
import { site } from "@/lib/site";

const SAMPLE = `import { Layer, Schema } from "effect";
import { Action, Command, createRuntime, define } from "@wych/react";

const Bumped = Action("Bumped", {});
const Reached = Action.output("Reached", { at: Schema.Number });

const counter = define({
  props: Schema.Struct({ step: Schema.Number }),
  state: Schema.Struct({ count: Schema.Number }),
  action: Action.of([Bumped]),
  output: Action.of([Reached]),
}).create({
  initialState: (props) => ({ count: props.step }),
  reducer: {
    Bumped: (_payload, { state, props }) => {
      const count = state.count + props.step;
      return count >= 10
        ? [{ count }, Command.output(Reached, { at: count })]
        : { count };
    },
  },
  render: ({ state, dispatch }) => (
    <button onClick={() => dispatch(Bumped.make({}))}>{state.count}</button>
  ),
});

const { component } = createRuntime(Layer.empty);
export const Counter = component(counter, { name: "Counter" });`;

const SECTION_BLURBS: Record<string, string> = {
  Tutorial: "One app, three chapters: build a feature, add async work, compose features.",
  "How-to": "Debounce, streams, tests without React, server rendering, devtools.",
  Reference: "Every export: runtime, features, actions, commands, lifecycle, tasks, devtools.",
  Explanation: "The model, the two channels, commands as data, groups and cancellation.",
};

export default async function Home() {
  const [sections, sample] = await Promise.all([
    docsBySection(),
    renderMarkdown(`\`\`\`tsx\n${SAMPLE}\n\`\`\``),
  ]);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-20 px-6 py-16 md:py-24">
        <section className="grid items-center gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div className="flex flex-col items-start gap-6">
            <Badge variant="outline">Effect v4 · React 19</Badge>
            <h1 className="text-4xl font-medium tracking-tight text-balance md:text-5xl">
              {site.tagline}
            </h1>
            <p className="max-w-prose text-base leading-7 text-muted-foreground">
              A feature is schema-typed props and state, a tagged action vocabulary, an optional
              output vocabulary, and a pure reducer. The reducer returns the next state and,
              optionally, a <code className="font-mono text-sm">Command</code> that describes work.
              The runtime interprets commands as Effects and renders the feature as a React
              component.
            </p>
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
            <pre className="w-full overflow-x-auto border bg-muted px-4 py-3 font-mono text-xs text-foreground">
              <code>{site.install}</code>
            </pre>
          </div>
          <div
            className="prose prose-neutral min-w-0 max-w-none dark:prose-invert prose-pre:my-0 prose-pre:rounded-none prose-pre:border prose-pre:border-border prose-pre:bg-card prose-pre:text-xs prose-pre:leading-6 prose-pre:text-foreground"
            dangerouslySetInnerHTML={{ __html: sample }}
          />
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
          <span className="font-heading">{site.name}</span>
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
