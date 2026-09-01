---
title: Compared with other libraries
description: Where Wych overlaps with Redux Toolkit, XState and useReducer, and a direct map from TCA.
order: 6
---

# Compared with other libraries

Wych is a reducer that owns a mount. That puts it next to three tools a React
and Effect developer already knows, and next to one a Swift developer already
knows. Each comparison names the real gap, not just the shared vocabulary.

Every section reuses one feature: a search box backed by a debounced task.

```tsx
import { Action, Command, define, Task } from "@wych/react";
import { Context, Effect, Layer, Schema } from "effect";

const Hits = Schema.Array(Schema.String);

class SearchApi extends Context.Service<
  SearchApi,
  { readonly hits: (query: string) => Effect.Effect<ReadonlyArray<string>> }
>()("SearchApi") {}

const Typed = Action("Typed", { query: Schema.String });

const search = Task("Search", {
  success: Hits,
  onError: Task.message,
  run: (query: string) => Effect.flatMap(SearchApi, (api) => api.hits(query)),
});

const Search = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ query: Schema.String, results: Task.schema(Hits) }),
  action: Action.of([Typed, ...search.actions]),
});

const searchFeature = Search.create({
  initialState: () => ({ query: "", results: Task.idle }),
  reducer: {
    Typed: ({ query }, { state }) => Task.start({ ...state, query }, "results", search.run(query)),
    SearchResolved: ({ value }, { state }) => ({ ...state, results: Task.resolved(value) }),
    SearchRejected: ({ error }, { state }) => ({ ...state, results: Task.rejected(error) }),
  },
  render: ({ state, dispatch }) => (
    <input
      value={state.query}
      onChange={(event) => dispatch(Typed.make({ query: event.target.value }))}
    />
  ),
});
```

## Redux Toolkit

RTK holds one global store. Every slice's state lives at a path in one tree,
every component subscribes to the paths it needs, and thunks or listener
middleware run the side effects outside the reducer.

```ts fragment
// RTK: one store, a slice, and a thunk for the side effect
const searchSlice = createSlice({
  name: "search",
  initialState: { query: "", results: [] as Array<string> },
  reducers: {
    typed: (state, action: PayloadAction<string>) => {
      state.query = action.payload;
    },
  },
});

const runSearch = createAsyncThunk("search/run", async (query: string, { extra }) =>
  extra.searchApi.hits(query),
);
```

Wych's state lives on the mount, not on a global path. There is no store to
subscribe a component to, because `search.results` only exists where
`<Search />` is mounted.

```tsx continue
const result = await Effect.runPromise(
  searchFeature.run([Typed.make({ query: "cats" })], {
    props: {},
    hooks: {},
    layer: Layer.succeed(SearchApi)({ hits: (q) => Effect.succeed([`${q} result`]) }),
  }),
);
console.log(result.state);
// => { query: "cats", results: { _tag: "Resolved", value: ["cats result"] } }
```

RTK's thunk is a function that closes over `dispatch` and runs outside the
reducer, so the reducer cannot see what it will do. Wych's reducer returns the
command as a value: `Task.start` above is data returned from the `Typed`
handler, not a call made from it. See
[Commands as data](/docs/explanation/commands-as-data) for why that split
matters for testing and replay.

Use RTK for state that several unrelated parts of the app read: the signed-in
user, a feature-flag set, a normalized entity cache. Use Wych for state that
belongs to one part of the tree: a search box, a form, a wizard step. The two
compose: an RTK-held `customerId` becomes a prop into a Wych feature, same as
any other prop.

Wych's devtools event stream is deliberately shaped like RTK's: a
`DevtoolsTransition` carries `previous`, `next`, `action` and `cause`, the same
fields an RTK devtools trace shows for a slice. See
[Devtools](/docs/reference/devtools) for the full event union.

## XState

Both are state machines. XState makes the machine explicit: states and
transitions are declared as data, the machine can be drawn, and it supports
hierarchical and parallel states plus actors invoked from a state.

```js
// XState: states and transitions are the source of truth
const searchMachine = createMachine({
  initial: "idle",
  states: {
    idle: { on: { TYPED: "debouncing" } },
    debouncing: {
      after: { 300: "searching" },
      on: { TYPED: "debouncing" },
    },
    searching: {
      invoke: { src: "hits", onDone: "idle", onError: "idle" },
    },
  },
});
```

Wych has no state names and no transition table. It is reducer-shaped: one
function from `(action, state)` to `Next`, and the async lifecycle a
statechart draws as `debouncing` → `searching` is plain Effect inside the
command.

```ts fragment
const debounced = Command.restart(
  "results",
  Command.effect((dispatch) =>
    Effect.sleep("300 millis").pipe(
      Effect.andThen(Effect.flatMap(SearchApi, (api) => api.hits("cats"))),
      Effect.flatMap((hits) => dispatch({ _tag: "SearchResolved", value: hits })),
    ),
  ),
);
```

There is exactly one supervisory concept: a named fiber group, addressed with
`Command.keyed`, `Command.cancel` and `Command.restart`. `restart` above is
`batch(cancel("results"), keyed("results", command))`, not a state. Everything
past that is Effect combinators (`Effect.sleep`, `Effect.race`,
`Stream.debounce`), not runtime API. See
[Groups and cancellation](/docs/explanation/groups-and-cancellation).

Reach for XState when the states themselves need a diagram, or when you need
parallel regions and nested child machines invoked from a parent state. Reach
for Wych when the async and dependency-injection story matters more than the
state diagram, and the app is already on Effect: `SearchApi` above is a `Layer`
supplied once at `createRuntime`, not a mock injected per test file.

## useReducer + TanStack Query

The plain-React baseline is `useReducer` for local state and TanStack Query
for the request. It gets you most of the way, with four real gaps.

```tsx fragment
// Plain React: the effect lives outside the reducer, uncancellable by name
function useSearch() {
  const [state, dispatch] = useReducer(reducer, { query: "" });
  const { data } = useQuery({
    queryKey: ["search", state.query],
    queryFn: () => searchApi.hits(state.query),
  });
  useEffect(() => {
    // debounce, cancel-on-unmount, and the previous request's race
    // are hand-rolled here, not owned by the reducer
  }, [state.query]);
  return { state, data, dispatch };
}
```

- **No cancel key.** `useEffect`'s cleanup cancels the _previous render's_
  effect. There is no name to `cancel` or `restart` on demand, the way
  `Command.restart("results", ...)` does above.
- **No headless fold.** A reducer plus `useEffect` cannot be exercised without
  mounting a component. `feature.run` above folds a sequence of actions and
  reports `state`, `emitted` and `outputs` with no DOM. See
  [Test a feature without React](/docs/how-to/test-a-feature-without-react).
- **No typed outbound channel.** A parent component gets state changes through
  a prop it defines and hopes gets called at the right time. Wych's `on<Tag>`
  props are derived from `Action.output` and required by the type, not
  discovered by reading the child. See
  [Actions and outputs](/docs/explanation/actions-and-outputs).
- **Lifecycle is not in the reducer.** `useEffect(() => {...}, [])` is outside
  the state machine. Wych's `Mounted` and `Unmounted` are handlers in the same
  reducer as `Typed`, so startup and teardown fold the same way every other
  action does.

Wych does not replace TanStack Query's cache and background refetch; a
`Task.run` can call a query client the same way it calls any other service.
See [Use with the React ecosystem](/docs/how-to/use-with-the-react-ecosystem) for wiring
the two together.

## For TCA developers

The mapping is close to 1:1. Bring the vocabulary, not the reducer
composition.

| TCA                                  | Wych                                                      |
| ------------------------------------ | --------------------------------------------------------- |
| `Reducer` / `State` / `Action`       | `define({ state, action })` + `reducer`                   |
| `.run` + `.cancellable(id:)`         | `Command.effect` + `Command.keyed` / `cancel` / `restart` |
| `@Dependency`                        | An Effect `Layer` supplied to `createRuntime`             |
| `TestStore`                          | `feature.run`, folds to quiescence                        |
| A delegate action                    | An output (`Action.output`, `on<Tag>`)                    |
| `Store`                              | `component(feature, { name })`                            |
| `withViewStore` / `@ObservableState` | `render` and `Component.useFeature()`                     |

```swift
// TCA: an effect with a cancellation id
case .typed(let query):
  state.query = query
  return .run { send in
    try await Task.sleep(for: .milliseconds(300))
    let hits = try await api.hits(query)
    await send(.searchResponse(hits))
  }
  .cancellable(id: CancelID.search, cancelInFlight: true)
```

```ts fragment
// Wych: the same shape, addressed by a group name instead of a cancellation id
Typed: ({ query }, { state }) =>
  Task.start({ ...state, query }, "results", search.run(query)),
// Task's default mode is "latest": Command.restart under the group "results"
```

`TestStore`'s assert-and-step loop and `feature.run`'s fold both answer "what
happens after these actions," headless. `feature.run` returns the end state
plus everything a command sent back through the reducer or out through an
output, in one call:

```ts continue
const traced = await Effect.runPromise(
  searchFeature.run([Typed.make({ query: "cats" })], {
    props: {},
    hooks: {},
    layer: Layer.succeed(SearchApi)({ hits: (q) => Effect.succeed([`${q}!`]) }),
  }),
);
console.log(traced.emitted.map((a) => a._tag));
// => ["SearchResolved"]
```

The real gap: TCA composes at the reducer, with `Scope`, `ifLet` and
`forEach` pulling a child reducer into a parent's `body`. Wych composes at the
component. A parent feature never touches a child's reducer; it mounts the
child's component and receives the child's outputs as typed props, the same
way any two React components talk.

```tsx fragment
<SearchResult onSelected={({ id }) => dispatch({ _tag: "ResultPicked", id })} />
```

There is no `ifLet`-shaped optional child and no `forEach`-shaped list of
child reducers folded into one state tree. A list of children is a list of
mounted components, each with its own state, the pattern built out in
[Composing features](/docs/tutorial/composing-features) and explained in
[Actions and outputs](/docs/explanation/actions-and-outputs).
