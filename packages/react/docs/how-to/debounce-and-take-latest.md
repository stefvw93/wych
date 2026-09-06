---
title: Debounce and take latest
description: Wait for a pause in typing, then interrupt the request that is still in flight.
order: 1
example: search-debounce
---

# Debounce and take latest

A search box in React fires a request on every keystroke. The `useEffect` that fetches grows a timer, the timer grows a cleanup, and a ref drops the response from the keystroke before. Wych puts both rules in the reducer: wait 300 ms before the request, and interrupt whatever the previous keystroke started.

## Debounce inside the command

`Command.restart(name, command)` cancels the group booked under `name`, then books the replacement under it. The delay is `Effect.sleep` inside the leaf.

```tsx
import { Action, Command, define, Task } from "@wych/react";
import { Context, Effect, Layer, Schema } from "effect";

const Hits = Schema.Array(Schema.String);

class SearchApi extends Context.Service<
  SearchApi,
  { readonly hits: (query: string, page?: number) => Effect.Effect<ReadonlyArray<string>> }
>()("SearchApi") {}

const Typed = Action("Typed", { query: Schema.String });
const Loaded = Action("Loaded", { hits: Hits });

const searchFeature = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String, hits: Hits }),
  action: Action.of([Typed, Loaded]),
}).create({
  initialState: () => ({ query: "", hits: [] }),
  reducer: {
    Typed: ({ query }, { state }) => [
      { ...state, query },
      Command.restart(
        "query",
        Command.effect((dispatch) =>
          Effect.gen(function* () {
            yield* Effect.sleep("300 millis");
            const api = yield* SearchApi;
            const hits = yield* api.hits(query);
            yield* dispatch(Loaded.make({ hits }));
          }),
        ),
      ),
    ],
    Loaded: ({ hits }, { state }) => ({ ...state, hits }),
  },
  render: ({ state, dispatch }) => (
    <div>
      <input
        value={state.query}
        onChange={(event) => dispatch(Typed.make({ query: event.target.value }))}
      />
      <ul>
        {state.hits.map((hit) => (
          <li key={hit}>{hit}</li>
        ))}
      </ul>
    </div>
  ),
});
```

The reducer stays pure. It returns the command as a value, and the runtime forks it under the group `"query"`.

The next keystroke returns the same command again. Its `cancel` half interrupts the sleeping fiber before the replacement is booked, so only the last keystroke reaches `SearchApi`. See [groups and cancellation](/docs/explanation/groups-and-cancellation) for how the group namespace works.

## Take latest with a task

`Task` declares the two result actions and the command. Its default `mode` is `"latest"`, which books the work under `Task/${Name}` with `Command.restart`.

```tsx continue
const search = Task("Search", {
  success: Hits,
  onError: Task.message,
  run: (query: string) =>
    Effect.gen(function* () {
      const api = yield* SearchApi;
      return yield* api.hits(query);
    }),
});

const Cleared = Action("Cleared", {});

const taskSearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String, results: Task.schema(Hits) }),
  action: Action.of([Typed, Cleared, ...search.actions]),
}).create({
  initialState: () => ({ query: "", results: Task.idle }),
  reducer: {
    Typed: ({ query }, { state }) => Task.start({ ...state, query }, "results", search.run(query)),
    Cleared: (_payload, { state }) => [{ ...state, query: "", results: Task.idle }, search.cancel],
    SearchResolved: ({ value }, { state }) => ({ ...state, results: Task.resolved(value) }),
    SearchRejected: ({ error }, { state }) => ({ ...state, results: Task.rejected(error) }),
  },
  render: ({ state, dispatch }) => (
    <div>
      <input
        value={state.query}
        onChange={(event) => dispatch(Typed.make({ query: event.target.value }))}
      />
      <button onClick={() => dispatch(Cleared.make({}))}>clear</button>
      {Task.match(state.results, {
        Idle: () => null,
        Pending: () => <p>Searching</p>,
        Rejected: ({ error }) => <p>{error}</p>,
        Resolved: ({ value }) => (
          <ul>
            {value.map((hit) => (
              <li key={hit}>{hit}</li>
            ))}
          </ul>
        ),
      })}
    </div>
  ),
});
```

`Task.start` writes `Pending` into `results` on the same fold that issues the command, so the view never paints a gap. `search.cancel` interrupts the group and dispatches nothing, so the `Cleared` handler writes `Task.idle` itself.

### Where the delay lives

`mode` is a property of the operation. It is declared once, and every handler that calls `search.run` gets it. A delay in `run` follows the same rule: every trigger of the search waits.

```ts fragment
run: (query: string) =>
  Effect.gen(function* () {
    yield* Effect.sleep("300 millis");
    const api = yield* SearchApi;
    return yield* api.hits(query);
  }),
```

Put the delay in `run` when the wait belongs to the search itself, wherever it is triggered from. Keep the delay in the handler's leaf, as `searchFeature` does, when the wait belongs to one action. A `Typed` handler waits for the typing to pause; a `Submitted` handler for the Enter key issues the request at once. A task declared without `run` takes the effect at the call site, so each handler can pass its own delay. The [tasks reference](/docs/reference/tasks) shows that form and the full signatures.

## Compare "latest" and "every"

`mode: "every"` books with `Command.keyed` and never interrupts. Declare a second task to see both results land.

```tsx continue
const searchEvery = Task("SearchEvery", {
  success: Hits,
  onError: Task.message,
  mode: "every",
  run: (query: string) =>
    Effect.gen(function* () {
      const api = yield* SearchApi;
      return yield* api.hits(query);
    }),
});

const everySearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ results: Task.schema(Hits) }),
  action: Action.of([Typed, ...searchEvery.actions]),
}).create({
  initialState: () => ({ results: Task.idle }),
  reducer: {
    Typed: ({ query }, { state }) => Task.start(state, "results", searchEvery.run(query)),
    SearchEveryResolved: ({ value }, { state }) => ({
      ...state,
      results: Task.resolved(value),
    }),
    SearchEveryRejected: ({ error }, { state }) => ({
      ...state,
      results: Task.rejected(error),
    }),
  },
  render: () => null,
});
```

`mode: "every"` is for work where every run must finish: a save per row, an upload per file, or a result the `Resolved` handler appends to state. Each run dispatches its own `SearchEveryResolved`, in the order the requests settle.

A single `TaskValue` field holds whichever result arrived last. If an older request settles after a newer one, the field shows the older hits. That is why a search box keeps the default `"latest"`. Both modes book under `Task/SearchEvery`, so `searchEvery.cancel` interrupts every run in flight.

`feature.run` folds a sequence of actions and reports what the commands emitted. Two keystrokes, one slow API, and the two modes diverge.

```tsx continue
const slowApi = Layer.succeed(SearchApi)({
  hits: (query) => Effect.sleep("50 millis").pipe(Effect.as([`${query}!`])),
});

const keystrokes = [Typed.make({ query: "a" }), Typed.make({ query: "ab" })];
const options = { props: {}, hooks: {}, layer: slowApi };

const latest = await Effect.runPromise(taskSearch.run(keystrokes, options));
// => latest.emitted: [{ _tag: "SearchResolved", value: ["ab!"] }]

const every = await Effect.runPromise(everySearch.run(keystrokes, options));
// => every.emitted: [
//      { _tag: "SearchEveryResolved", value: ["a!"] },
//      { _tag: "SearchEveryResolved", value: ["ab!"] },
//    ]
```

The `"a"` fiber is still sleeping when `"ab"` arrives. `"latest"` interrupts it, and an interrupted task dispatches nothing.

The `search-debounce` example ships this comparison as a vitest file, `src/search.test.ts`, run with `npm test` or `vp -C packages/react/docs/examples/search-debounce run test`.

## Load the next page

A "more" button asks for the page after the one on screen. The handler writes `page + 1` into the state and the request needs that same number. `Task.start` accepts a thunk in place of the command. The thunk receives the state the handler built, with `Pending` already written, so the page number is read once, from the state that holds it.

```tsx continue
const searchPage = Task("SearchPage", {
  success: Hits,
  onError: Task.message,
  run: ({ query, page }: { readonly query: string; readonly page: number }) =>
    Effect.gen(function* () {
      const api = yield* SearchApi;
      return yield* api.hits(query, page);
    }),
});

const MoreClicked = Action("MoreClicked", {});

const pagedSearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String, page: Schema.Number, results: Task.schema(Hits) }),
  action: Action.of([Typed, MoreClicked, ...searchPage.actions]),
}).create({
  initialState: () => ({ query: "", page: 1, results: Task.idle }),
  reducer: {
    Typed: ({ query }, { state }) =>
      Task.start({ ...state, query, page: 1 }, "results", (next) => searchPage.run(next)),
    MoreClicked: (_payload, { state }) =>
      Task.start({ ...state, page: state.page + 1 }, "results", (next) => searchPage.run(next)),
    SearchPageResolved: ({ value }, { state }) => ({ ...state, results: Task.resolved(value) }),
    SearchPageRejected: ({ error }, { state }) => ({ ...state, results: Task.rejected(error) }),
  },
  render: ({ state, dispatch }) => (
    <div>
      <input
        value={state.query}
        onChange={(event) => dispatch(Typed.make({ query: event.target.value }))}
      />
      <button onClick={() => dispatch(MoreClicked.make({}))}>more</button>
      {Task.match(state.results, {
        Idle: () => null,
        Pending: () => <p>Loading page {state.page}</p>,
        Rejected: ({ error }) => <p>{error}</p>,
        Resolved: ({ value }) => (
          <ul>
            {value.map((hit) => (
              <li key={hit}>{hit}</li>
            ))}
          </ul>
        ),
      })}
    </div>
  ),
});
```

Use the thunk when the command reads a field the handler computes: the incremented `page`, a trimmed query, a generated id. Pass the command outright when its input is the payload, as `taskSearch` does with `query`. The [features reference](/docs/reference/features#next) shows the same form for a handler without a task field.

`searchPage` keeps the default `"latest"`, so a click on "more" while page 1 is still loading interrupts that request. One result arrives, for the page the state holds.

```tsx continue
const pagedApi = Layer.succeed(SearchApi)({
  hits: (query, page) => Effect.sleep("50 millis").pipe(Effect.as([`${query} p${page}`])),
});

const paged = await Effect.runPromise(
  pagedSearch.run([Typed.make({ query: "a" }), MoreClicked.make({})], {
    props: {},
    hooks: {},
    layer: pagedApi,
  }),
);
console.log(paged.emitted);
// => [{ _tag: "SearchPageResolved", value: ["a p2"] }]
console.log(paged.state.page);
// => 2
```

## Mount it

The root layer supplies `SearchApi`, so `component` needs no layer of its own.

```tsx continue
import { createRuntime } from "@wych/react";
import { createRoot } from "react-dom/client";

const api = Layer.succeed(SearchApi)({
  hits: (query) => Effect.succeed([`${query} result`]),
});

const { component } = createRuntime(api);

const Search = component(taskSearch, { name: "Search" });

const App = () => <Search />;

createRoot(document.getElementById("root")!).render(<App />);
```

Every feature in this page mounts the same way. None of them declares an output, so the components take no `on<Tag>` props.
