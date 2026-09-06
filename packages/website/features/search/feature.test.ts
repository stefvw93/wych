import { Next, Task } from "@wych/react";
import { Effect, Layer } from "effect";
import { expect, test } from "vite-plus/test";
import {
  docsSearch,
  type Hit,
  hrefOf,
  initial,
  Moved,
  Navigated,
  Reset,
  SearchEngine,
  type State,
  Submitted,
  Typed,
} from "./feature";

const hit = (overrides: Partial<Hit> = {}): Hit => ({
  id: "reference/commands#commandrestart",
  slug: "reference/commands",
  section: "Reference",
  title: "Commands",
  heading: "Command.restart",
  anchor: "commandrestart",
  content: "restart is take-latest in one call.",
  terms: ["restart"],
  ...overrides,
});

/** An engine that answers every query with one hit naming the query. */
const echo = (options: { readonly warmed?: { count: number } } = {}) =>
  Layer.succeed(SearchEngine)({
    warm: Effect.sync(() => {
      if (options.warmed) options.warmed.count += 1;
    }),
    search: (query) => Effect.succeed([hit({ id: query, heading: query })]),
  });

const failing = Layer.succeed(SearchEngine)({
  warm: Effect.void,
  search: () => Effect.fail(new Error("search index: 404")),
});

const snapshot = (state: Partial<State> = {}) => ({
  state: { ...initial, ...state },
  props: { open: true },
  hooks: {},
});

const resolved = (...hits: Hit[]): State => ({
  ...initial,
  query: "q",
  results: Task.resolved(hits),
});

// --- one step with reduce ---------------------------------------------------

test("Typed writes the query, resets the selection and starts the search", () => {
  const next = docsSearch.reduce(Typed.make({ query: "res" }), snapshot({ selected: 3 }));

  expect(Next.state(next)).toEqual({ query: "res", results: Task.pending, selected: 0 });
  expect(Next.command(next)).toBeDefined();
});

test("an empty query goes idle and cancels the search in flight", () => {
  const next = docsSearch.reduce(
    Typed.make({ query: "   " }),
    snapshot({ query: "re", results: Task.pending }),
  );

  expect(Next.state(next)).toEqual({ query: "   ", results: Task.idle, selected: 0 });
  expect(Next.command(next)).toBeDefined();
});

test("Moved wraps around the result list and is a no-op with no results", () => {
  const three = resolved(hit({ id: "a" }), hit({ id: "b" }), hit({ id: "c" }));

  expect(Next.state(docsSearch.reduce(Moved.make({ delta: 1 }), snapshot(three))).selected).toBe(1);
  expect(
    Next.state(docsSearch.reduce(Moved.make({ delta: -1 }), snapshot({ ...three, selected: 0 })))
      .selected,
  ).toBe(2);
  expect(
    Next.state(docsSearch.reduce(Moved.make({ delta: 1 }), snapshot({ ...three, selected: 2 })))
      .selected,
  ).toBe(0);
  expect(Next.state(docsSearch.reduce(Moved.make({ delta: 1 }), snapshot()))).toEqual(initial);
});

test("Submitted with nothing selected asks for nothing", () => {
  const next = docsSearch.reduce(Submitted.make({}), snapshot());

  expect(Next.state(next)).toEqual(initial);
  expect(Next.command(next)).toBeUndefined();
});

test("Submitted with a selection keeps state and issues the output command", () => {
  const next = docsSearch.reduce(
    Submitted.make({}),
    snapshot({ ...resolved(hit({ id: "a" }), hit({ id: "b", anchor: "b" })), selected: 1 }),
  );

  expect(Next.state(next).selected).toBe(1);
  expect(Next.command(next)).toBeDefined();
});

test("closing the dialog resets the feature", () => {
  const next = docsSearch.reduce(
    { _tag: "PropsChanged", previous: { open: true } },
    { ...snapshot(resolved(hit())), props: { open: false } },
  );

  expect(Next.state(next)).toEqual(initial);
  expect(Next.command(next)).toBeDefined();
});

test("Reset returns to the initial state", () => {
  expect(Next.state(docsSearch.reduce(Reset.make({}), snapshot(resolved(hit()))))).toEqual(initial);
});

test("hrefOf maps the index page to /docs and adds the anchor", () => {
  expect(hrefOf(hit())).toBe("/docs/reference/commands#commandrestart");
  expect(hrefOf(hit({ slug: "", anchor: "" }))).toBe("/docs");
  expect(hrefOf(hit({ slug: "tutorial/async-work", anchor: "" }))).toBe(
    "/docs/tutorial/async-work",
  );
});

// --- a sequence with run ----------------------------------------------------

const options = (layer: Layer.Layer<SearchEngine>) => ({ props: { open: true }, hooks: {}, layer });

test("a keystroke resolves to hits after the debounce", async () => {
  const { state, emitted } = await Effect.runPromise(
    docsSearch.run([Typed.make({ query: "restart" })], options(echo())),
  );

  expect(emitted).toEqual([
    { _tag: "SearchResolved", value: [hit({ id: "restart", heading: "restart" })] },
  ]);
  expect(state.results).toEqual(Task.resolved([hit({ id: "restart", heading: "restart" })]));
});

test("take latest: a newer keystroke interrupts the search still waiting", async () => {
  const { state, emitted } = await Effect.runPromise(
    docsSearch.run(
      [Typed.make({ query: "r" }), Typed.make({ query: "re" }), Typed.make({ query: "res" })],
      options(echo()),
    ),
  );

  expect(emitted).toEqual([
    { _tag: "SearchResolved", value: [hit({ id: "res", heading: "res" })] },
  ]);
  expect(state.query).toBe("res");
});

test("clearing the input cancels the search: nothing resolves", async () => {
  const { state, emitted } = await Effect.runPromise(
    docsSearch.run([Typed.make({ query: "r" }), Typed.make({ query: "" })], options(echo())),
  );

  expect(emitted).toEqual([]);
  expect(state.results).toEqual(Task.idle);
});

test("Enter on a resolved hit leaves through onNavigated", async () => {
  // Seeded actions fold one event-loop turn apart, so a Typed would still be
  // inside its debounce when Submitted folds. Seed the resolution itself.
  const { outputs } = await Effect.runPromise(
    docsSearch.run(
      [
        { _tag: "SearchResolved", value: [hit({ id: "a" }), hit({ id: "b", anchor: "b" })] },
        Moved.make({ delta: 1 }),
        Submitted.make({}),
      ],
      options(echo()),
    ),
  );

  expect(outputs).toEqual([Navigated.make({ href: "/docs/reference/commands#b" })]);
});

test("a failed engine lands in Rejected with its message, and announces nothing", async () => {
  const { state, outputs } = await Effect.runPromise(
    docsSearch.run([Typed.make({ query: "restart" }), Submitted.make({})], options(failing)),
  );

  expect(state.results).toEqual(Task.rejected("search index: 404"));
  expect(outputs).toEqual([]);
});

test("mounting and opening warm the engine; a second open warms again, for free", async () => {
  const warmed = { count: 0 };
  await Effect.runPromise(
    docsSearch.run(
      [
        { _tag: "Mounted" },
        { _tag: "PropsChanged", previous: { open: false } },
        { _tag: "PropsChanged", previous: { open: true } },
      ],
      options(echo({ warmed })),
    ),
  );

  expect(warmed.count).toBe(2);
});
