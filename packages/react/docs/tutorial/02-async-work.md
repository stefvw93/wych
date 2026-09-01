---
title: Async work
description: Save the note through an Effect service, with Task for the pending, resolved and rejected states.
order: 2
---

# Async work

The editor from [chapter 1](/docs/tutorial/your-first-feature) holds text and
nothing else. Saving it needs three things: a service to call, a command to
carry the call, and a state field to hold the outcome.

`Task` gives you the last two. You keep the reducer pure.

## 1. Declare the service

The save call lives in an Effect service, so a test can hand the feature a
different implementation.

```ts
// notes-api.ts
import { Context, Effect, Layer } from "effect";

export class NotesApi extends Context.Service<
  NotesApi,
  {
    readonly save: (note: {
      readonly id: string;
      readonly text: string;
    }) => Effect.Effect<string, Error>;
  }
>()("NotesApi") {}

export const notesApiLayer = Layer.succeed(NotesApi)({
  save: (note) => Effect.succeed(`${note.id}@${Date.now()}`),
});
```

`save` answers with the revision id of the stored note. The layer above is a
stub. Swap in a real HTTP call and nothing else on this page changes.

## 2. Hand the layer to the runtime

`createRuntime` takes the root layer. Every command mounted under it can ask
for `NotesApi`.

```ts continue
// runtime.ts
import { createRuntime } from "@wych/react";

export const { component } = createRuntime(notesApiLayer);
```

A feature whose commands need a service the root does not have is a compile
error at `component`.

## 3. Declare the task

`Task` declares two actions and the command that produces them. The name
prefixes both tags, so this one gives you `SaveResolved` and `SaveRejected`.

```ts continue
// note-editor.tsx
import { Schema } from "effect";
import { Action, Task, define } from "@wych/react";

const saveNote = Task("Save", {
  success: Schema.String,
  onError: Task.message,
  run: (note: { readonly id: string; readonly text: string }) =>
    Effect.flatMap(NotesApi, (api) => api.save(note)),
});
```

`onError` maps every bad ending to the failure type. `Task.message` takes the
message off the cause, which pairs with the default `Schema.String` failure.
Typed failures and defects both go through it. Interruption dispatches nothing.

## 4. Add the task field to state

`Task.schema` is the state field. It holds one of four cases: `Idle`,
`Pending`, `Resolved { value }`, `Rejected { error }`.

```ts continue
const TextChanged = Action("TextChanged", { text: Schema.String });
const Reverted = Action("Reverted", {});
const SaveClicked = Action("SaveClicked", {});
const SaveCancelled = Action("SaveCancelled", {});

const Editor = define({
  props: Schema.Struct({ noteId: Schema.String, initialText: Schema.String }),
  state: Schema.Struct({
    text: Schema.String,
    dirty: Schema.Boolean,
    save: Task.schema(Schema.String),
  }),
  action: Action.of([TextChanged, Reverted, SaveClicked, SaveCancelled, ...saveNote.actions]),
});

const initialState = Editor.initialState((props) => ({
  text: props.initialText,
  dirty: false,
  save: Task.idle,
}));
```

The two generated actions are spread into the vocabulary, beside the ones you
wrote. The reducer now owes a handler for each.

## 5. Start the task, then write the result

`Task.start(state, key, command)` writes `Pending` into `key` and returns the
command beside it. The write lands on the fold that issued the command, so the
view is already in its pending state when the click handler returns.

```ts continue
const reducer = Editor.reducer({
  TextChanged: ({ text }, { props }) => ({
    text,
    dirty: text !== props.initialText,
    save: Task.idle,
  }),
  Reverted: (_payload, { props }) => ({
    text: props.initialText,
    dirty: false,
    save: Task.idle,
  }),
  SaveClicked: (_payload, { state, props }) =>
    Task.start(state, "save", saveNote.run({ id: props.noteId, text: state.text })),
  SaveCancelled: (_payload, { state }) => [{ ...state, save: Task.idle }, saveNote.cancel],
  SaveResolved: ({ value }, { state }) => ({
    ...state,
    dirty: false,
    save: Task.resolved(value),
  }),
  SaveRejected: ({ error }, { state }) => ({ ...state, save: Task.rejected(error) }),
});
```

`key` is checked against the state's task fields, so a renamed field is a
compile error. `saveNote.cancel` interrupts whatever the task has in flight.
It writes nothing, which is why the same handler clears the field.

## 6. Render the four cases

`Task.match` is total. A missing arm does not compile, so a forgotten failure
state cannot ship as a blank screen.

```tsx continue
const render = Editor.render(({ state, dispatch }) => (
  <form>
    <textarea
      value={state.text}
      onChange={(event) => dispatch(TextChanged.make({ text: event.target.value }))}
    />
    <button type="button" disabled={!state.dirty} onClick={() => dispatch({ _tag: "Reverted" })}>
      Revert
    </button>
    <button type="button" onClick={() => dispatch(SaveClicked.make({}))}>
      Save
    </button>
    <button type="button" onClick={() => dispatch(SaveCancelled.make({}))}>
      Cancel
    </button>
    {Task.match(state.save, {
      Idle: () => null,
      Pending: () => <span>Saving...</span>,
      Resolved: ({ value }) => <span>Saved as {value}</span>,
      Rejected: ({ error }) => <span role="alert">{error}</span>,
    })}
  </form>
));
```

Each arm receives the whole case, so `Resolved` reads `value` and `Rejected`
reads `error`. The arms may return different types.

## 7. Mount it

`main.tsx` is unchanged from chapter 1.

```tsx continue
const editor = Editor.create({ initialState, reducer, render });

export const NoteEditor = component(editor, { name: "NoteEditor" });
```

Press Save and the label reads `Saving...`, then `Saved as n1@...`. The
revision comes from the stub layer.

## 8. Two saves, one result

A task is take-latest by default. A second run interrupts the first, and the
interrupted run dispatches nothing.

`feature.run` folds a list of actions to quiescence against a layer you choose,
with no React in the path.

```ts continue
const slowSave = Layer.succeed(NotesApi)({
  save: (note) => Effect.as(Effect.sleep("50 millis"), `${note.id}@2`),
});

const twoSaves = await Effect.runPromise(
  editor.run([SaveClicked.make({}), SaveClicked.make({})], {
    props: { noteId: "n1", initialText: "Buy milk" },
    hooks: {},
    layer: slowSave,
  }),
);

console.log(twoSaves.emitted.map((action) => action._tag));
// => ["SaveResolved"]
console.log(twoSaves.state.save);
// => { _tag: "Resolved", value: "n1@2" }
```

The first save was interrupted. Interruption is a normal ending for a task, so
no `SaveRejected` arrives.

## 9. Cancel a save in flight

```ts continue
const cancelled = await Effect.runPromise(
  editor.run([SaveClicked.make({}), SaveCancelled.make({})], {
    props: { noteId: "n1", initialText: "Buy milk" },
    hooks: {},
    layer: slowSave,
  }),
);

console.log(cancelled.emitted);
// => []
console.log(cancelled.state.save);
// => { _tag: "Idle" }
```

## The files

```sh
src/
  notes-api.ts     # the NotesApi service and its layer
  runtime.ts       # createRuntime(notesApiLayer)
  note-editor.tsx  # the task, the feature, the component
  main.tsx         # unchanged
```

Split across the files, the imports between them are:

```ts fragment
import { notesApiLayer } from "./notes-api"; // runtime.ts
import { NotesApi } from "./notes-api"; // note-editor.tsx
import { component } from "./runtime"; // note-editor.tsx
import { NoteEditor } from "./note-editor"; // main.tsx
```

## Next

One editor saves one note. A list that mounts many editors, and hears about
every save, is [chapter 3](/docs/tutorial/composing-features).

For every option on `Task`, including `mode: "every"` and a typed failure
schema, see [Tasks](/docs/reference/tasks). For the command constructors
underneath it, see [Commands](/docs/reference/commands).
