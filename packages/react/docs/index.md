---
title: Overview
description: A feature runtime for React. Pure reducers, Effect commands, tests that need no renderer.
order: 0
example: search-debounce
---

# @wych/react

A search box in React is a `useState` for the query, a `useState` for the
results, a `useEffect` that fetches, a cleanup that tries to cancel, and a ref
that drops the response from the keystroke before. The rules live in four
places, none of them is the reducer, and none of them runs without a DOM.

Wych puts the rules in one place. A feature is a pure reducer over
schema-typed state. A handler returns the next state and, when there is work
to do, a `Command`: an Effect the runtime forks, books under a name, and
interrupts when a later action says so. The same reducer folds under React,
under a test, or by hand.

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

// Two actions (SearchResolved, SearchRejected) and one cancellable command.
const search = Task("Search", {
  success: Hits,
  onError: Task.message,
  run: (query: string) =>
    Effect.gen(function* () {
      const api = yield* SearchApi;
      return yield* api.hits(query);
    }),
});

const taskSearch = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String, results: Task.schema(Hits) }),
  action: Action.of([Typed, Cleared, ...search.actions]),
}).create({
  initialState: () => ({ query: "", results: Task.idle }),
  reducer: {
    // Take latest: a new Typed interrupts the fiber still resolving the old one.
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

The fetch, the cancel and the race are in the `Typed` handler, as a value.
`Task.start` writes `Pending` on the same fold, so the button is disabled
before the click handler returns. `search.cancel` is a command too, so a
different action can interrupt the request.

The proof does not need React. Feed two keystrokes to `run` with an API slow
enough that the first is still in flight when the second arrives, and read
what resolved.

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

One result, from the last keystroke. The `"a"` request was interrupted, and an
interrupted task dispatches nothing.

Three consumers read the same reducer through one command interpreter:
`feature.reduce` folds one action, `feature.run` folds a sequence until
nothing is left running, and `component` mounts it. A test written with `run` measures the
behaviour the mounted component has.

## Status

Alpha, on Effect v4 release candidates. Two limits worth knowing before you
start: `run` never resolves while a never-completing command is in flight,
and `run` discards a command that dies. Both are explained in
[commands as data](/docs/explanation/commands-as-data).

## Install

```sh
npm install @wych/react effect react react-dom
```

`effect` (v4), `react` and `react-dom` are peer dependencies.

## Tutorial

One app, three chapters. Start here.

- [Your first feature](/docs/tutorial/your-first-feature): a note editor with a dirty flag, mounted in React and folded in a test with no DOM.
- [Async work](/docs/tutorial/async-work): save through a service, hold the pending, resolved and rejected states in one field.
- [Composing features](/docs/tutorial/composing-features): a list that mounts many editors and hears each one save.

## How-to

- [Debounce and take latest](/docs/how-to/debounce-and-take-latest): wait for the typing to pause, then drop the request still in flight.
- [Subscribe to a stream](/docs/how-to/subscribe-to-a-stream): open a long-lived source on mount, rebook it when a prop changes, close it on unmount.
- [Test a feature without React](/docs/how-to/test-a-feature-without-react): fold actions, swap the layer, assert on what was emitted.
- [Render on the server](/docs/how-to/render-on-the-server): paint the initial state with `renderToString`, then hydrate the same feature.
- [Install devtools](/docs/how-to/install-devtools): log every transition, command and output to the console, or forward them elsewhere.
- [Use with AI agents](/docs/how-to/use-with-ai-agents): point an agent at the docs that ship in the package.
- [Use with the React ecosystem](/docs/how-to/use-with-the-react-ecosystem): bring any hook in, hand any client to a Layer, send outputs out. TanStack Query worked through.

## Reference

- [Runtime](/docs/reference/runtime): `createRuntime`, `component`, `useFeature`, output props, props validation.
- [Features](/docs/reference/features): `define`, `create`, `reduce`, `run`, `Next`, `Children`.
- [Actions and outputs](/docs/reference/actions): `Action`, `Action.output`, `Action.of`, the two channels.
- [Commands](/docs/reference/commands): every constructor, groups, the contextual typing rule.
- [Lifecycle](/docs/reference/lifecycle): the five runtime actions and change detection.
- [Tasks](/docs/reference/tasks): `Task`, `TaskValue`, the matcher and guards.
- [Devtools](/docs/reference/devtools): the service, sinks, the event union, the recorder.

## Explanation

- [The model](/docs/explanation/the-model): what a `useEffect` graph is hiding, and the shape that replaces it.
- [Actions and outputs](/docs/explanation/actions-and-outputs): why a feature has two message channels and the outbound one never folds.
- [Commands as data](/docs/explanation/commands-as-data): why a handler describes work instead of doing it.
- [Groups and cancellation](/docs/explanation/groups-and-cancellation): how a later action reaches work an earlier one started.
- [Children and opaque props](/docs/explanation/children-and-opaque-props): why a React node cannot be a schema value, and what `Children` gives up to carry one.
- [Compared with other libraries](/docs/explanation/comparisons): where Wych sits next to Redux Toolkit, XState, `useReducer` and TCA.
