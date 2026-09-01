---
title: The model
description: A feature is schemas, vocabularies, a pure reducer and commands the runtime interprets.
order: 1
---

Wych puts The Elm Architecture on React. A feature holds its own state, folds actions into it, and describes work as data. The runtime interprets that data.

A feature is declared from values, so there are no type arguments to write.

```ts
import { Action, Command, createRuntime, define, Next } from "@wych/react";
import { Context, Effect, Layer, Schema } from "effect";

const TextEdited = Action("TextEdited", { text: Schema.String });
const Saved = Action("Saved", {});

const NoteEditor = define({
  props: Schema.Struct({ noteId: Schema.String }),
  state: Schema.Struct({ text: Schema.String, saving: Schema.Boolean }),
  action: Action.of([TextEdited, Saved]),
});
```

Four things are named there. Props and state are `Schema.Struct`s, so both have a checked shape at the edge and a TypeScript type inside. The action vocabulary is a tagged union built from `Action`. A feature that talks to its parent adds an `output` vocabulary, described in [actions and outputs](/docs/explanation/actions-and-outputs).

## The reducer describes, the runtime does

`define` hands back the pieces of the feature. `create` joins them.

```ts continue
class Notes extends Context.Service<
  Notes,
  { readonly save: (id: string, text: string) => Effect.Effect<void> }
>()("Notes") {}

const noteEditor = NoteEditor.create({
  initialState: () => ({ text: "", saving: false }),
  reducer: {
    TextEdited: ({ text }, { state, props }) => [
      { ...state, text, saving: true },
      Command.effect((dispatch) =>
        Effect.flatMap(Notes, (notes) => notes.save(props.noteId, text)).pipe(
          Effect.flatMap(() => dispatch({ _tag: "Saved" as const })),
        ),
      ),
    ],
    Saved: (_payload, { state }) => ({ ...state, saving: false }),
  },
  render: ({ state }) => state.text,
});
```

The handler computes the next state and returns a `Command` beside it. It calls nothing, waits for nothing, and touches no `Ref`. The effect inside `Command.effect` is a value too: it runs when the runtime forks it.

A handler receives the action payload with `_tag` stripped, because the handler key already named the tag. The second argument is the snapshot: `state`, `props` and `hooks`.

## The same reducer, called three ways

`feature.reduce` is the reducer as one pure function. No React, no Effect runtime.

```ts continue
const next = noteEditor.reduce(
  { _tag: "TextEdited", text: "hello" },
  { state: { text: "", saving: false }, props: { noteId: "n1" }, hooks: {} },
);

Next.state(next); // => { text: "hello", saving: true }
Next.command(next); // => { _tag: "Effect", effect: … }
```

`feature.run` folds a sequence of actions, runs each command against a `Layer`, feeds what a command emits back in, and reports what left. It resolves at quiescence.

```ts continue
const notesLayer = Layer.succeed(Notes)({ save: () => Effect.sync(() => {}) });

Effect.runPromise(
  noteEditor.run([{ _tag: "TextEdited", text: "hello" }], {
    props: { noteId: "n1" },
    hooks: {},
    layer: notesLayer,
  }),
);
// => { state: { text: "hello", saving: false },
//      emitted: [{ _tag: "Saved" }],
//      outputs: [] }
```

`component` is the React binding. It mounts the feature, folds dispatches, and paints `render`.

```ts continue
const runtime = createRuntime(notesLayer);
const Editor = runtime.component(noteEditor, { name: "NoteEditor" });
```

All three read commands through one interpreter. `Next.command` is the single place a lazy command resolves, and grouping and cancellation have one implementation. A test written with `run` therefore measures the behaviour the mounted component has. Two interpreters would have to agree forever, and would drift.

The seam has a cost worth knowing: `run` never resolves while a never-completing command is in flight. See [commands as data](/docs/explanation/commands-as-data).

## Where React state hooks fit

Feature state lives in the feature. `render` reads `state` and calls `dispatch`; it holds no `useState`, no `useReducer`, and no `useEffect`. A view fragment under the mount reads the same snapshot through `Component.useFeature()`.

```ts continue
const NoteCount = () => {
  const { state, dispatch } = Editor.useFeature();
  return state.saving ? "saving" : `${state.text.length} characters`;
};
```

Two reasons for the rule. State kept in React is invisible to `reduce` and `run`, so it cannot be tested headlessly or shown in devtools. Work started in `useEffect` is outside the fiber book, so nothing cancels it on unmount.

## Where `useUnsafeHooks` fits

Some inputs only exist in React: a router, a media query, a data-fetching hook from another library. `useUnsafeHooks` calls them in render position and hands the values to the feature as `hooks`.

```ts
import { Action, define } from "@wych/react";
import { Schema } from "effect";

declare function useOnlineStatus(): boolean;

const TextEdited = Action("TextEdited", { text: Schema.String });

const NoteEditor = define({
  props: Schema.Struct({ noteId: Schema.String }),
  state: Schema.Struct({ text: Schema.String, offline: Schema.Boolean }),
  action: Action.of([TextEdited]),
  useUnsafeHooks: () => ({ online: useOnlineStatus() }),
});
```

A change in any hook value raises `HookChanged`, so the feature folds ambient input the way it folds a dispatch.

```ts continue
const noteEditor = NoteEditor.create({
  initialState: () => ({ text: "", offline: false }),
  reducer: {
    TextEdited: ({ text }, { state }) => ({ ...state, text }),
    HookChanged: (_payload, { state, hooks }) => ({ ...state, offline: !hooks.online }),
  },
  render: ({ state }) => (state.offline ? "offline" : state.text),
});
```

It is named unsafe because it opens the feature to whatever the hook does. The values are ambient input, so a hook that owns state the feature should own moves the feature back into React. Full signatures are in [features](/docs/reference/features) and [lifecycle](/docs/reference/lifecycle).
