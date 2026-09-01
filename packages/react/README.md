# @wych/react

A TEA-style feature runtime for React, built on [Effect](https://effect.website).

A feature is schema-typed props and state, a tagged action vocabulary, an
optional output vocabulary, and a pure reducer. The reducer returns the next
state and, optionally, a `Command` that describes work. The runtime interprets
commands as Effects and renders the feature as a React component.

Async state logic is unit-testable to quiescence without a DOM: fold a
sequence of actions through the reducer and read what it resolved to.

## Install

```sh
npm install @wych/react effect react react-dom
```

`effect` (v4), `react` and `react-dom` are peer dependencies.

## A feature

```tsx
import { Context, Effect, Layer, Schema } from "effect";
import { Action, createRuntime, define, Task } from "@wych/react";

const Hits = Schema.Array(Schema.String);

class SearchApi extends Context.Service<
  SearchApi,
  { readonly hits: (query: string) => Effect.Effect<ReadonlyArray<string>> }
>()("SearchApi") {}

const Typed = Action("Typed", { query: Schema.String });
const Cleared = Action("Cleared", {});

const search = Task("Search", {
  success: Hits,
  onError: Task.message,
  run: (query: string) => Effect.flatMap(SearchApi, (api) => api.hits(query)),
});

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

const api = Layer.succeed(SearchApi)({
  hits: (query) => Effect.succeed([`${query} result`]),
});

const { component } = createRuntime(api);
export const Search = component(taskSearch, { name: "Search" });
```

```tsx
<Search />
```

The same feature folds without React. `taskSearch` takes the latest result: a
slow request for `"a"` is still in flight when `"ab"` arrives, and `Task`'s
default `mode: "latest"` interrupts it.

```tsx
const slowApi = Layer.succeed(SearchApi)({
  hits: (query) => Effect.sleep("50 millis").pipe(Effect.as([`${query}!`])),
});

const result = await Effect.runPromise(
  taskSearch.run([Typed.make({ query: "a" }), Typed.make({ query: "ab" })], {
    props: {},
    hooks: {},
    layer: slowApi,
  }),
);
console.log(result.emitted);
// => [{ _tag: "SearchResolved", value: ["ab!"] }]
console.log(result.state.results);
// => { _tag: "Resolved", value: ["ab!"] }
```

## Docs

The docs ship inside this package at `node_modules/@wych/react/docs`.

- `docs/tutorial/`: one app in three chapters.
- `docs/how-to/`: recipes for a competent reader.
- `docs/reference/`: every export and its contract.
- `docs/explanation/`: why the model is shaped this way.

Start with `docs/index.md`.

## License

MIT
