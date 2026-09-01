---
title: Debounce and take latest
description: Wait for a pause in typing, then interrupt the request that is still in flight.
order: 1
example: search-debounce
---

# Debounce and take latest

A search box issues work on every keystroke. Wait 300 ms before the request, and interrupt whatever the previous keystroke started.

## Debounce inside the command

`Command.restart(name, command)` cancels the group booked under `name`, then books the replacement under it. The delay is `Effect.sleep` inside the leaf.

```tsx
import { Action, Command, define, Task } from "@wych/react";
import { Context, Effect, Layer, Schema } from "effect";

const Hits = Schema.Array(Schema.String);

class SearchApi extends Context.Service<
  SearchApi,
  { readonly hits: (query: string) => Effect.Effect<ReadonlyArray<string>> }
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
          Effect.sleep("300 millis").pipe(
            Effect.andThen(Effect.flatMap(SearchApi, (api) => api.hits(query))),
            Effect.flatMap((hits) => dispatch(Loaded.make({ hits }))),
          ),
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
  run: (query: string) => Effect.flatMap(SearchApi, (api) => api.hits(query)),
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

The debounce moves into `run` when you want both: `run: (query) => Effect.sleep("300 millis").pipe(Effect.andThen(...))`. Full signatures are in the [tasks reference](/docs/reference/tasks).

## Compare "latest" and "every"

`mode: "every"` books with `Command.keyed` and never interrupts. Declare a second task to see both results land.

```tsx continue
const searchEvery = Task("SearchEvery", {
  success: Hits,
  onError: Task.message,
  mode: "every",
  run: (query: string) => Effect.flatMap(SearchApi, (api) => api.hits(query)),
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

Both features in this page mount the same way. `searchFeature` and `taskSearch` declare no outputs, so the component takes no `on<Tag>` props.
