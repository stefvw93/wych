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
  actions: [Typed, Loaded],
}).create({
  initialState: () => ({ query: "", hits: [] }),
  reducer: {
    Typed: ({ query }, { draft }) => {
      draft.query = query;
      return [
        draft,
        Command.restart(
          "query",
          Command.effect((dispatch) =>
            Effect.gen(function* () {
              yield* Effect.sleep("300 millis");
              const api = yield* SearchApi;
              const hits = yield* api.hits(query);
              yield* dispatch(Loaded, { hits });
            }),
          ),
        ),
      ];
    },
    Loaded: ({ hits }, { draft }) => {
      draft.hits = [...hits];
      return draft;
    },
  },
  render: ({ state, dispatch }) => (
    <div>
      <input
        value={state.query}
        onChange={(event) => dispatch(Typed, { query: event.target.value })}
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

`Task` declares the two settle actions and the command. `tasks: { results: search }` on `define` gives the task the `results` state field: the field is a `TaskValue`, starts `Idle`, and the two actions join the reducer. Its default `mode` is `"latest"`, which books the work under `Task/${Name}` with `Command.restart`.

```tsx continue
const search = Task("Search", {
  success: Hits,
  run: (query: string) =>
    Effect.gen(function* () {
      const api = yield* SearchApi;
      return yield* api.hits(query);
    }),
});

const Cleared = Action("Cleared");

const taskSearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String }),
  tasks: { results: search },
  actions: [Typed, Cleared],
}).create({
  initialState: () => ({ query: "" }),
  reducer: {
    Typed: ({ query }, { draft, tasks }) => {
      draft.query = query;
      return tasks.results.start(query);
    },
    Cleared: (_payload, { draft, tasks }) => {
      draft.query = "";
      return tasks.results.cancel();
    },
  },
  render: ({ state, dispatch }) => (
    <div>
      <input
        value={state.query}
        onChange={(event) => dispatch(Typed, { query: event.target.value })}
      />
      <button onClick={() => dispatch(Cleared)}>clear</button>
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

`tasks.results.start(query)` writes `Pending` into `results` on the same fold that issues the command, so the view never paints a gap. When the request settles, the fold writes `Resolved` or `Rejected` into the field; no handler is needed. `tasks.results.cancel()` writes `Idle` and interrupts the group, which dispatches nothing. No `failure` schema is declared, so the error is the cause's message.

### Where the delay lives

`mode` is a property of the operation. It is declared once, and every handler that calls `start` gets it. A delay in `run` follows the same rule: every trigger of the search waits.

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
  mode: "every",
  run: (query: string) =>
    Effect.gen(function* () {
      const api = yield* SearchApi;
      return yield* api.hits(query);
    }),
});

const everySearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  tasks: { results: searchEvery },
  actions: Typed,
}).create({
  initialState: () => ({}),
  reducer: {
    Typed: ({ query }, { tasks }) => tasks.results.start(query),
  },
  render: () => null,
});
```

`mode: "every"` is for work where every run must finish: a save per row, an upload per file, or a result the `Resolved` handler appends to state. Each run dispatches its own `SearchEveryResolved`, in the order the requests settle.

A single `TaskValue` field holds whichever result arrived last. If an older request settles after a newer one, the field shows the older hits. That is why a search box keeps the default `"latest"`. Both modes book under `Task/SearchEvery`, so `tasks.results.cancel()` interrupts every run in flight.

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

A "more" button asks for the page after the one on screen. The handler writes `page + 1` into the draft and the request needs that same number. A handler may write other draft fields before it calls `start`, and reads them back from the draft, so the page number is written once and read from the draft that holds it.

```tsx continue
const searchPage = Task("SearchPage", {
  success: Hits,
  run: ({ query, page }: { readonly query: string; readonly page: number }) =>
    Effect.gen(function* () {
      const api = yield* SearchApi;
      return yield* api.hits(query, page);
    }),
});

const MoreClicked = Action("MoreClicked");

const pagedSearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String, page: Schema.Number }),
  tasks: { results: searchPage },
  actions: [Typed, MoreClicked],
}).create({
  initialState: () => ({ query: "", page: 1 }),
  reducer: {
    Typed: ({ query }, { draft, tasks }) => {
      draft.query = query;
      draft.page = 1;
      return tasks.results.start({ query, page: 1 });
    },
    MoreClicked: (_payload, { draft, tasks }) => {
      draft.page += 1;
      return tasks.results.start({ query: draft.query, page: draft.page });
    },
  },
  render: ({ state, dispatch }) => (
    <div>
      <input
        value={state.query}
        onChange={(event) => dispatch(Typed, { query: event.target.value })}
      />
      <button onClick={() => dispatch(MoreClicked)}>more</button>
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

`start` returns the one draft that holds every write, `page` and `Pending` alike, beside the command. Read the input off the draft when the command needs a field the handler computes: the incremented `page`, a trimmed query, a generated id. Pass the payload outright when it is the input, as `taskSearch` does with `query`.

`searchPage` keeps the default `"latest"`, so a click on "more" while page 1 is still loading interrupts that request. One result arrives, for the page the state holds.

```tsx continue
const pagedApi = Layer.succeed(SearchApi)({
  hits: (query, page) => Effect.sleep("50 millis").pipe(Effect.as([`${query} p${page}`])),
});

const paged = await Effect.runPromise(
  pagedSearch.run([Typed.make({ query: "a" }), MoreClicked.make()], {
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
