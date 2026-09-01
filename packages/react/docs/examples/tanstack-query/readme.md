# TanStack Query

## Overview

A `NoteEditor` feature that reads a note through TanStack Query's `useQuery`
and saves it through the same `QueryClient`, wired in as an Effect service.
One `QueryClient` instance, in `src/main.tsx`, feeds both `QueryClientProvider`
and the runtime's Layer.

## Problem

A feature's state lives on its mount, but a fetched value often needs a
cache: dedup across mounts, refetch-on-focus, staleness. Wych does not build
that. Hand-rolling it inside a `Command.effect` means throwing away
TanStack Query's cache to reinvent a worse one.

The save side has a mirror problem: after a feature saves through its own
service, a `useQuery` elsewhere in the tree, reading the same data, has no way
to know it's stale.

## Solution

Split the two directions. The read path pulls `useQuery`'s result into the
reducer through `useUnsafeHooks` (`src/note-editor.tsx`), so `HookChanged`
folds a fetched note into `draft` the same way any other action does. The
write path is a `Task` (`save`, also in `note-editor.tsx`) whose `run` reads
the `Queries` service, saves, and calls `client.invalidateQueries`.

```ts
// src/queries.ts
export class Queries extends Context.Service<Queries, QueryClient>()("Queries") {}
```

`src/main.tsx` constructs one `QueryClient` and gives it to both halves:

```ts
const queryClient = new QueryClient();
const { component } = createRuntime(Layer.succeed(Queries)(queryClient));
```

## How It Works

`note-editor.tsx`'s `useUnsafeHooks` calls `useQuery` in render position and
returns two primitives, `text` and `status`, never the query object itself.
Hooks are compared per key with `Object.is`; returning the result object
would raise `HookChanged` on every render, since TanStack Query returns a new
object each time.

```ts
useUnsafeHooks: (props) => {
  const query = useQuery({
    queryKey: noteKey(props.noteId),
    queryFn: () => fetchNote(props.noteId),
  });
  return { text: query.data?.text, status: query.status };
},
```

The `HookChanged` handler adopts the fetched text as the draft, but only when
it actually changed:

```ts
HookChanged: ({ previous }, { state, hooks }) =>
  hooks.text !== undefined && hooks.text !== previous.text
    ? { ...state, draft: hooks.text }
    : state,
```

`Submitted` starts the `save` task. On success it invalidates the note's
query key, so `main.tsx`'s `Preview` component, a plain `useQuery` consumer
on the same key with no Wych involved, refetches too:

```ts
run: ({ id, text }) =>
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

`src/note-editor.test.ts` proves both paths need no React. The read path
folds a `HookChanged` action through `noteEditor.reduce` with a plain `hooks`
object, no `QueryClientProvider` required. The write path runs `noteEditor.run`
against a real `new QueryClient()`, no React runtime at all, and asserts
`client.getQueryState(noteKey("n1"))?.isInvalidated === true` after the save.

## When to Use

Reach for this pattern whenever a feature's data already has a TanStack Query
cache elsewhere in the app, and the feature needs to read that cache and
write back through it, keeping every consumer of the key in sync.

Skip it when nothing outside the feature reads the same data: a task hitting
a service directly (see [Async work](/docs/tutorial/async-work)) is simpler
and needs no `QueryClient` at all.
