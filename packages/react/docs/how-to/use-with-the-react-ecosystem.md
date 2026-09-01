---
title: Use with the React ecosystem
description: Any hook through useUnsafeHooks, any client as a Layer, outputs on the way out — TanStack Query as the worked example.
order: 7
example: tanstack-query
---

# Use with the React ecosystem

Wych is not a store, not an atom library, not a server cache. It composes
with them, through three seams.

- **In, via hooks.** `useUnsafeHooks` runs in render position, so any hook's
  value reaches the reducer as `snapshot.hooks`, and a change raises
  `HookChanged`. Hooks are compared per key with `Object.is`, so return
  primitives or stable references. This works for `useQuery`, a router's
  `useParams`, Redux's `useSelector`, Jotai's `useAtomValue`, Zustand's
  `useStore`, alike.
- **Out, via a Layer.** Any client with methods (a `QueryClient`, a Redux
  store's `dispatch`, a router's `navigate`, an analytics client) becomes an
  Effect service, supplied once at `createRuntime`. Commands and `Task.run`
  reach it through the Layer, and a test swaps it for a fake.
- **Out, via outputs.** `Action.output` becomes a required `on<Tag>` prop.
  That is how a feature hands a result to whatever owns the rest of the tree:
  a parent, a store, a router. See
  [Actions and outputs](/docs/explanation/actions-and-outputs).

One feature can use all three at once:

```tsx
import { Context, Effect, Layer, Schema } from "effect";
import { Action, Command, createRuntime, define } from "@wych/react";

// In, via a hook: its value reaches the reducer as `snapshot.hooks`.
const useIsOnline = (): boolean => navigator.onLine;

// Out, via a Layer: a client with methods becomes an Effect service.
class Analytics extends Context.Service<
  Analytics,
  { readonly track: (event: string) => Effect.Effect<void> }
>()("Analytics") {}

const AnalyticsLayer = Layer.succeed(Analytics)({ track: () => Effect.void });

const Submitted = Action("Submitted", {});
// Out, via an output: leaves through a required `onTracked` prop, never back into the reducer.
const Tracked = Action.output("Tracked", { event: Schema.String });

const form = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ online: Schema.Boolean }),
  action: Action.of([Submitted]),
  output: Action.of([Tracked]),
  useUnsafeHooks: () => ({ online: useIsOnline() }),
}).create({
  initialState: () => ({ online: true }),
  reducer: {
    HookChanged: (_payload, { state, hooks }) => ({ ...state, online: hooks.online }),
    Submitted: (_payload, { state }) => [
      state,
      Command.batch(
        Command.effect(() =>
          Effect.flatMap(Analytics, (analytics) => analytics.track("submitted")),
        ),
        Command.output(Tracked, { event: "submitted" }),
      ),
    ],
  },
  render: () => null,
});

const { component } = createRuntime(AnalyticsLayer);
const Form = component(form, { name: "Form" });
```

## Worked example: TanStack Query

Wych integrates with TanStack Query. It does not replace it: the cache,
refetch-on-focus, dedup and staleness stay TanStack's. Wych owns the reducer
that turns a fetched value and a save button into state.

One `QueryClient` instance goes to both sides: `QueryClientProvider` for
hooks, and the runtime layer for commands.

```tsx
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRuntime } from "@wych/react";
import { Context, Layer } from "effect";
import { createRoot } from "react-dom/client";

export class Queries extends Context.Service<Queries, QueryClient>()("Queries") {}

export const noteKey = (id: string) => ["note", id] as const;

const queryClient = new QueryClient();
const { component } = createRuntime(Layer.succeed(Queries)(queryClient));
```

### Read a query into the reducer

`useQuery` runs in render position inside `useUnsafeHooks`. Its result
reaches the reducer as `snapshot.hooks`, and a change raises `HookChanged`.

Hooks are compared per key with `Object.is`, so return primitives
(`query.data?.text`, `query.status`), never the query result object: a new
object on every render would raise `HookChanged` every render. See
[Lifecycle: `HookChanged` and `useUnsafeHooks`](/docs/reference/lifecycle#hookchanged-and-useunsafehooks).

```tsx continue
import { Action, define } from "@wych/react";
import { Schema } from "effect";

const fetchNote = async (id: string) => ({ id, text: "Milk, eggs, bread" });

const Typed = Action("Typed", { text: Schema.String });

const noteReader = define({
  props: Schema.Struct({ noteId: Schema.String }),
  state: Schema.Struct({ draft: Schema.String }),
  action: Action.of([Typed]),
  useUnsafeHooks: (props) => {
    const query = useQuery({
      queryKey: noteKey(props.noteId),
      queryFn: () => fetchNote(props.noteId),
    });
    return { text: query.data?.text, status: query.status };
  },
}).create({
  initialState: () => ({ draft: "" }),
  reducer: {
    // The cache filled or refetched: adopt the server text as the draft.
    HookChanged: ({ previous }, { state, hooks }) =>
      hooks.text !== undefined && hooks.text !== previous.text
        ? { ...state, draft: hooks.text }
        : state,
    Typed: ({ text }, { state }) => ({ ...state, draft: text }),
  },
  render: ({ state, hooks }) => (
    <div>
      {hooks.status === "pending" && <p>Loading</p>}
      <textarea value={state.draft} readOnly />
    </div>
  ),
});
```

### Save through the QueryClient as a Layer

The save runs as a `Task` whose `run` reads `Queries` from context, saves with
`Effect.tryPromise`, then invalidates the key with `client.invalidateQueries`.
Every `useQuery` on that key refetches, including plain TanStack consumers
outside Wych.

```tsx continue
import { Command, Task } from "@wych/react";
import { Effect } from "effect";

const saveNote = async (id: string, text: string) => {
  if (text.trim() === "") throw new Error("a note cannot be empty");
  return { id, text };
};

const Submitted = Action("Submitted", {});
const Saved = Action.output("Saved", { id: Schema.String });

const save = Task("Save", {
  success: Schema.String,
  onError: Task.message,
  run: ({ id, text }: { id: string; text: string }) =>
    Effect.gen(function* () {
      const client = yield* Queries;
      const note = yield* Effect.tryPromise({
        try: () => saveNote(id, text),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
      yield* Effect.promise(() => client.invalidateQueries({ queryKey: noteKey(id) }));
      return note.text;
    }),
});

const noteEditor = define({
  props: Schema.Struct({ noteId: Schema.String }),
  state: Schema.Struct({ draft: Schema.String, save: Task.schema(Schema.String) }),
  action: Action.of([Typed, Submitted, ...save.actions]),
  output: Action.of([Saved]),
  useUnsafeHooks: (props) => {
    const query = useQuery({
      queryKey: noteKey(props.noteId),
      queryFn: () => fetchNote(props.noteId),
    });
    return { text: query.data?.text, status: query.status };
  },
}).create({
  initialState: () => ({ draft: "", save: Task.idle }),
  reducer: {
    HookChanged: ({ previous }, { state, hooks }) =>
      hooks.text !== undefined && hooks.text !== previous.text
        ? { ...state, draft: hooks.text }
        : state,
    Typed: ({ text }, { state }) => ({ ...state, draft: text }),
    Submitted: (_payload, { state, props }) =>
      Task.start(state, "save", save.run({ id: props.noteId, text: state.draft })),
    SaveResolved: ({ value }, { state, props }) => [
      { ...state, draft: value, save: Task.resolved(value) },
      Command.output(Saved, { id: props.noteId }),
    ],
    SaveRejected: ({ error }, { state }) => ({ ...state, save: Task.rejected(error) }),
  },
  render: ({ state, hooks, dispatch }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        dispatch(Submitted.make({}));
      }}
    >
      {hooks.status === "pending" && <p>Loading</p>}
      <textarea
        value={state.draft}
        disabled={hooks.status !== "success"}
        onChange={(event) => dispatch(Typed.make({ text: event.target.value }))}
      />
      <button type="submit" disabled={Task.isPending(state.save)}>
        {Task.isPending(state.save) ? "Saving" : "Save"}
      </button>
    </form>
  ),
});

const NoteEditor = component(noteEditor, { name: "NoteEditor" });

const App = () => (
  <QueryClientProvider client={queryClient}>
    <NoteEditor noteId="n1" onSaved={({ id }) => console.log("saved", id)} />
  </QueryClientProvider>
);

createRoot(document.getElementById("root")!).render(<App />);
```

### Test without a `QueryClientProvider`

Hooks are plain data in a fold, so the read path needs no `QueryClientProvider`:
pass the `hooks` object `run` and `reduce` already take.

```ts fragment
import { Next, Task } from "@wych/react";

const loaded = { text: "Milk, eggs, bread", status: "success" as const };

const next = noteEditor.reduce(
  { _tag: "HookChanged", previous: { text: undefined, status: "pending" } },
  { state: { draft: "", save: Task.idle }, props: { noteId: "n1" }, hooks: loaded },
);

console.log(Next.state(next).draft);
// => "Milk, eggs, bread"
```

The write path runs against a real `QueryClient`, with no React. Assert on
`getQueryState` directly.

```ts fragment
import { QueryClient } from "@tanstack/react-query";
import { Effect, Layer } from "effect";

const client = new QueryClient();
await client.prefetchQuery({ queryKey: noteKey("n1"), queryFn: () => fetchNote("n1") });

const result = await Effect.runPromise(
  noteEditor.run([Typed.make({ text: "Oat milk" }), Submitted.make({})], {
    props: { noteId: "n1" },
    hooks: loaded,
    layer: Layer.succeed(Queries)(client),
  }),
);

console.log(result.outputs);
// => [{ _tag: "Saved", id: "n1" }]
console.log(client.getQueryState(noteKey("n1"))?.isInvalidated);
// => true
```

See [Test a feature without React](/docs/how-to/test-a-feature-without-react)
for `reduce` and `run` in full, and
[Compared with other libraries](/docs/explanation/comparisons) for the wider
`useReducer` + TanStack Query comparison.

## The same shape elsewhere

TanStack Query is one client behind the same three seams. Any library that
exposes a hook and a plain-object client fits the same shape.

A router's params come in through `useUnsafeHooks`, the same way `useQuery`'s
result does:

```ts fragment
useUnsafeHooks: (props) => ({ id: useParams().id }),
```

A Redux store goes out through a Layer, the same way the `QueryClient` does.
A command dispatches to it with `Effect.sync`:

```ts fragment
const StoreLayer = Layer.succeed(Store)(store);

Command.effect(() => Effect.sync(() => store.dispatch({ type: "checkout/placed" })));
```

A Zustand or Jotai store reads in through `useUnsafeHooks`, projected to a
primitive:

```ts fragment
useUnsafeHooks: () => ({ theme: useStore((state) => state.theme) }),
```
