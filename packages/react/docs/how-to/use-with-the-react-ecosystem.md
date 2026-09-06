---
title: Use with the React ecosystem
description: Read any hook into the reducer through useUnsafeHooks, reach any client through a Layer, hand results out through outputs. TanStack Query is the worked example.
order: 7
example: tanstack-query
---

# Use with the React ecosystem

The app already has TanStack Query for its server cache, a router, and a form library. A new feature has to sit beside them: read what they hold, write through their clients, and hand its result to whatever owns the rest of the tree. A feature has three integration points, and each is one line in `define` or one command.

- A hook comes in through `useUnsafeHooks`. It runs in render position, its value reaches the reducer as `snapshot.hooks`, and a change raises `HookChanged`.
- A client goes out through a Layer. A `QueryClient`, a router's `navigate`, a store's `dispatch`: each becomes an Effect service supplied once at `createRuntime`, and a command reads it from context.
- A result goes out through an output. `Action.output` becomes a required `on<Tag>` prop on the component.

The note editor below uses all three: `useQuery` in, the `QueryClient` out through the `Queries` service, and a `Saved` output.

## Share one QueryClient

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

One instance goes to both sides: `QueryClientProvider` for hooks, and the runtime layer for commands. Two instances would give commands a cache no hook reads. The Layer is also the seam a test uses: it supplies its own `QueryClient` and asserts on it.

## Define the feature

```tsx continue
import { Action, Command, define, Task } from "@wych/react";
import { Effect, Schema } from "effect";

const fetchNote = async (id: string) => ({ id, text: "Milk, eggs, bread" });

const saveNote = async (id: string, text: string) => {
  if (text.trim() === "") throw new Error("a note cannot be empty");
  return { id, text };
};

const Typed = Action("Typed", { text: Schema.String });
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
    // The cache filled or refetched: adopt the server text as the draft.
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
      {hooks.status === "error" && <p>Could not load the note</p>}
      <textarea
        value={state.draft}
        disabled={hooks.status !== "success"}
        onChange={(event) => dispatch(Typed.make({ text: event.target.value }))}
      />
      <button type="submit" disabled={Task.isPending(state.save)}>
        {Task.isPending(state.save) ? "Saving" : "Save"}
      </button>
      {Task.match(state.save, {
        Idle: () => null,
        Pending: () => null,
        Resolved: () => <p>Saved</p>,
        Rejected: ({ error }) => <p>{error}</p>,
      })}
    </form>
  ),
});
```

TanStack keeps the cache, refetch-on-focus, dedup and staleness. The feature keeps the reducer that turns a fetched value and a save button into state. The `Task.match` at the end is exhaustive: one case per `TaskValue` tag.

### Read a query into the reducer

```ts fragment
useUnsafeHooks: (props) => {
  const query = useQuery({
    queryKey: noteKey(props.noteId),
    queryFn: () => fetchNote(props.noteId),
  });
  return { text: query.data?.text, status: query.status };
},
```

Two decisions here. First, what the hook returns. Hooks are compared per key with strict equality (`===`), so return primitives (`query.data?.text`, `query.status`) and never the query result object: `useQuery` builds a new object on every render, and that would raise `HookChanged` every render. See [Lifecycle: `HookChanged` and `useUnsafeHooks`](/docs/reference/lifecycle#hookchanged-and-useunsafehooks).

Second, when the reducer adopts the value. The `HookChanged` handler copies the server text into `draft` only when the text moved, so a refetch that returns the same text leaves a half-typed draft alone. Drop the `previous.text` guard if the server must always win.

### Save through the QueryClient

```ts fragment
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
```

The save is a `Task` whose `run` reads `Queries` from context, so no `import` of the client appears in the feature. `client.invalidateQueries` marks the key stale and every `useQuery` on it refetches, including plain TanStack consumers outside Wych. Use `client.setQueryData` instead when the save response is the new value and a second round trip is waste.

`onError: Task.message` keeps the error's message as a string, so `SaveRejected` renders it with no schema of its own.

### Hand the result to the parent

```ts fragment
SaveResolved: ({ value }, { state, props }) => [
  { ...state, draft: value, save: Task.resolved(value) },
  Command.output(Saved, { id: props.noteId }),
],
```

The cache update went through the Layer because TanStack owns the cache. `Saved` leaves as an output because the parent owns what happens next: navigation, a toast, a list refresh. Put a result on the side that owns it. See [Actions and outputs](/docs/explanation/actions-and-outputs).

## Mount it

```tsx continue
const NoteEditor = component(noteEditor, { name: "NoteEditor" });

const App = () => (
  <QueryClientProvider client={queryClient}>
    <NoteEditor noteId="n1" onSaved={({ id }) => console.log("saved", id)} />
  </QueryClientProvider>
);

createRoot(document.getElementById("root")!).render(<App />);
```

`onSaved` is required at the call site because `Saved` is declared in `output`. The provider holds the `queryClient` the runtime layer already holds.

## Test without a QueryClientProvider

Hooks are plain data in a fold, so the read path needs no `QueryClientProvider`: pass the `hooks` object `run` and `reduce` already take. Use `reduce` for one step and no Layer.

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

The write path runs against a real `QueryClient`, with no React. Use `run` when a command has to reach the Layer, and assert on `getQueryState` directly.

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

See [Test a feature without React](/docs/how-to/test-a-feature-without-react) for `reduce` and `run` in full, and [Compared with other libraries](/docs/explanation/comparisons) for the wider `useReducer` + TanStack Query comparison.

## The same shape elsewhere

Any library that exposes a hook and a plain-object client fits the same three points.

A router's params come in through `useUnsafeHooks`, the same way `useQuery`'s result does:

```ts fragment
useUnsafeHooks: (props) => ({ id: useParams().id }),
```

A Redux store goes out through a Layer, the same way the `QueryClient` does. A command reads the service, then dispatches:

```ts fragment
const StoreLayer = Layer.succeed(Store)(store);

Command.effect(() =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* Effect.sync(() => store.dispatch({ type: "checkout/placed" }));
  }),
);
```

A Zustand or Jotai store reads in through `useUnsafeHooks`, projected to a primitive:

```ts fragment
useUnsafeHooks: () => ({ theme: useStore((state) => state.theme) }),
```

A form library raises one decision: who owns the field values. When the library owns them, its form state comes in as primitives (`isValid`, `isDirty`) and the feature reacts to them. When the feature owns them, it keeps them in state, as the note editor keeps `draft`, and the library is only rendering.

```ts fragment
useUnsafeHooks: () => ({ valid: useFormContext().formState.isValid }),
```
