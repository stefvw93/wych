---
title: Overview
description: A TEA-style feature runtime for React, built on Effect.
order: 0
example: search-debounce
---

# @wych/react

A feature is schema-typed props and state, a tagged action vocabulary, an
optional output vocabulary, and a pure reducer. The reducer returns the next
state and, optionally, a `Command` that describes work. The runtime interprets
commands as Effects and renders the feature as a React component.

Async state logic is unit-testable to quiescence without a DOM: fold a
sequence of actions through the reducer and read what it resolved to.

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

// <Search />
```

`taskSearch` takes the latest result: a slow request for `"a"` is still in
flight when `"ab"` arrives, and `Task`'s default `mode: "latest"` interrupts
it. Fold both keystrokes with `run` and read the result without mounting
anything.

```tsx continue
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

Three consumers share one core and one command interpreter:

- `feature.reduce(action, snapshot)`: the reducer as one pure function.
- `feature.run(actions, options)`: folds a sequence to quiescence and reports
  what was emitted.
- `component(feature)`: the React binding.

## Install

```sh
npm install @wych/react effect react react-dom
```

`effect` (v4), `react` and `react-dom` are peer dependencies.

## Tutorial

One app, three chapters. Start here.

- [Your first feature](/docs/tutorial/your-first-feature): build a `NoteEditor`, mount it, fold one action without React.
- [Async work](/docs/tutorial/async-work): save through an Effect service with `Task`.
- [Composing features](/docs/tutorial/composing-features): a `NoteList` parent, outputs, `Children`, `useFeature`.

## How-to

- [Debounce and take latest](/docs/how-to/debounce-and-take-latest): wait for a pause, then interrupt the request in flight.
- [Subscribe to a stream](/docs/how-to/subscribe-to-a-stream): start a source on `Mounted`, cancel it on `Unmounted`.
- [Test a feature without React](/docs/how-to/test-a-feature-without-react): `reduce`, `run`, a test layer, the recorder.
- [Render on the server](/docs/how-to/render-on-the-server): `renderToString`, then hydrate.
- [Install devtools](/docs/how-to/install-devtools): the console logger, its options, a custom sink.
- [Use with AI agents](/docs/how-to/use-with-ai-agents): the docs ship in the package and at `/llms.txt`.
- [Use with the React ecosystem](/docs/how-to/use-with-the-react-ecosystem): any hook through `useUnsafeHooks`, any client as a Layer, outputs on the way out, with TanStack Query as the worked example.

## Reference

- [Runtime](/docs/reference/runtime): `createRuntime`, `component`, `useFeature`, output props, props validation.
- [Features](/docs/reference/features): `define`, `create`, `reduce`, `run`, `Next`, `Children`.
- [Actions and outputs](/docs/reference/actions): `Action`, `Action.output`, `Action.of`, channels.
- [Commands](/docs/reference/commands): every constructor, groups, the contextual typing rule.
- [Lifecycle](/docs/reference/lifecycle): the five runtime actions and change detection.
- [Tasks](/docs/reference/tasks): `Task`, `TaskValue`, the matcher and guards.
- [Devtools](/docs/reference/devtools): the service, sinks, the event union, the recorder.

## Explanation

- [The model](/docs/explanation/the-model): TEA on React, and why three consumers share one interpreter.
- [Actions and outputs](/docs/explanation/actions-and-outputs): why the outbound channel never reaches the reducer.
- [Commands as data](/docs/explanation/commands-as-data): why the reducer describes work and the runtime runs it.
- [Groups and cancellation](/docs/explanation/groups-and-cancellation): one flat namespace, `key ?? tag`, `restart` as sugar.
- [Compared with other libraries](/docs/explanation/comparisons): where Wych overlaps with Redux Toolkit, XState and useReducer, and a direct map from TCA.
- [Children and opaque props](/docs/explanation/children-and-opaque-props): why a React node cannot be a schema value.
