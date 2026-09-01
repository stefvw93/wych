---
title: Composing features
description: A NoteList parent that mounts NoteEditor children, hears their outputs, and takes children of its own.
order: 3
---

# Composing features

One editor saves one note. A list has to load many notes, mount an editor for
each, and know when one of them saved.

Features talk to each other the way React components do: props down, outputs up.
The child announces `Saved` and the parent receives it through an `onSaved`
prop. Nothing in the child knows a parent exists.

## 1. Add a list endpoint to the service

```ts
// notes-api.ts
import { Context, Effect, Layer, Schema } from "effect";

export const Note = Schema.Struct({ id: Schema.String, text: Schema.String });

export class NotesApi extends Context.Service<
  NotesApi,
  {
    readonly list: Effect.Effect<ReadonlyArray<typeof Note.Type>, Error>;
    readonly save: (note: {
      readonly id: string;
      readonly text: string;
    }) => Effect.Effect<string, Error>;
  }
>()("NotesApi") {}

export const notesApiLayer = Layer.succeed(NotesApi)({
  list: Effect.succeed([{ id: "n1", text: "Buy milk" }]),
  save: (note) => Effect.succeed(`${note.id}@${Date.now()}`),
});
```

```ts continue
// runtime.ts
import { createRuntime } from "@wych/react";

export const { component } = createRuntime(notesApiLayer);
```

## 2. Announce the save

`Action.output` declares an outbound message. `Command.output` emits one. The
editor is the chapter 2 file with those two lines added.

```tsx continue
// note-editor.tsx
import { Action, Command, Task, define } from "@wych/react";

const TextChanged = Action("TextChanged", { text: Schema.String });
const Reverted = Action("Reverted", {});
const SaveClicked = Action("SaveClicked", {});
const Saved = Action.output("Saved", { id: Schema.String, revision: Schema.String });

const saveNote = Task("Save", {
  success: Schema.String,
  onError: Task.message,
  run: (note: { readonly id: string; readonly text: string }) =>
    Effect.flatMap(NotesApi, (api) => api.save(note)),
});

const Editor = define({
  props: Schema.Struct({ noteId: Schema.String, initialText: Schema.String }),
  state: Schema.Struct({
    text: Schema.String,
    dirty: Schema.Boolean,
    save: Task.schema(Schema.String),
  }),
  action: Action.of([TextChanged, Reverted, SaveClicked, ...saveNote.actions]),
  output: Action.of([Saved]),
});

const editor = Editor.create({
  initialState: (props) => ({ text: props.initialText, dirty: false, save: Task.idle }),
  reducer: {
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
    SaveResolved: ({ value }, { state, props }) => [
      { ...state, dirty: false, save: Task.resolved(value) },
      Command.output(Saved, { id: props.noteId, revision: value }),
    ],
    SaveRejected: ({ error }, { state }) => ({ ...state, save: Task.rejected(error) }),
  },
  render: ({ state, dispatch }) => (
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
    </form>
  ),
});

export const NoteEditor = component(editor, { name: "NoteEditor" });
```

`Saved` has no reducer handler, and writing one is a compile error. An output
leaves the feature and never comes back. `NoteEditor` now takes a required
`onSaved` prop, derived from the tag.

## 3. Declare the parent

The list holds the loaded notes in a task field and the id of the note that
saved last. `Children` lets a caller put its own nodes inside the list.

```ts continue
// note-list.tsx
import { Children } from "@wych/react";

const NoteSaved = Action("NoteSaved", { id: Schema.String, revision: Schema.String });

const loadNotes = Task("Load", { success: Schema.Array(Note), onError: Task.message });

const List = define({
  props: Schema.Struct({ title: Schema.String, children: Schema.optionalKey(Children) }),
  state: Schema.Struct({
    notes: Task.schema(Schema.Array(Note)),
    lastSaved: Schema.String,
  }),
  action: Action.of([NoteSaved, ...loadNotes.actions]),
});
```

`loadNotes` declares no `run`, so its `run` takes the effect at the call site.
`Children` validates any node and is invisible to change detection. A parent
that passes a fresh node on every render raises no `PropsChanged`.

## 4. Load the notes on Mounted

`Mounted` fires once per mount, after the initial state exists. It is where
startup work goes.

```ts continue
const listReducer = List.reducer({
  Mounted: (_payload, { state }) =>
    Task.start(state, "notes", loadNotes.run(Effect.flatMap(NotesApi, (api) => api.list))),
  NoteSaved: ({ id }, { state }) => ({ ...state, lastSaved: id }),
  LoadResolved: ({ value }, { state }) => ({ ...state, notes: Task.resolved(value) }),
  LoadRejected: ({ error }, { state }) => ({ ...state, notes: Task.rejected(error) }),
});
```

Lifecycle handlers are optional and take the same shape as any other handler.
The five tags are `Mounted`, `PropsChanged`, `HookChanged`, `Error` and
`Unmounted`.

## 5. Split a piece of the view out

A plain React component under the mount reads the same snapshot `render` has,
through `useFeature`. It takes no props.

```tsx continue
const LastSaved = () => {
  const { state } = NoteList.useFeature();
  return state.lastSaved === "" ? null : <footer>Last saved: {state.lastSaved}</footer>;
};
```

`LastSaved` is part of the list's view, so it reads the list's state. Called
outside a `<NoteList>` it throws `TypeError: NoteList.useFeature() called
outside <NoteList>`.

## 6. Render the children

Each note gets a `NoteEditor`. `onSaved` receives the output payload with
`_tag` stripped, and turns it into an action of the parent's own.

```tsx continue
const noteList = List.create({
  initialState: () => ({ notes: Task.idle, lastSaved: "" }),
  reducer: listReducer,
  render: ({ state, props, dispatch }) => (
    <section>
      <h1>{props.title}</h1>
      {Task.match(state.notes, {
        Idle: () => null,
        Pending: () => <p>Loading notes...</p>,
        Rejected: ({ error }) => <p role="alert">{error}</p>,
        Resolved: ({ value }) => (
          <ul>
            {value.map((note) => (
              <li key={note.id}>
                <NoteEditor
                  noteId={note.id}
                  initialText={note.text}
                  onSaved={({ id, revision }) => dispatch(NoteSaved.make({ id, revision }))}
                />
              </li>
            ))}
          </ul>
        ),
      })}
      <LastSaved />
      {props.children}
    </section>
  ),
});

export const NoteList = component(noteList, { name: "NoteList" });
```

The child is a feature of its own with its own state. The parent reaches it
through props and hears from it through `onSaved`, the same way any React
component pair works.

## 7. Mount it

```tsx continue
// main.tsx
import { createRoot } from "react-dom/client";

const root = createRoot(document.getElementById("root")!);
root.render(
  <NoteList title="Notes">
    <p>Every note saves on its own.</p>
  </NoteList>,
);
```

The paragraph lands where `props.children` is rendered. Change it on a parent
render and the new node paints, while the list's state machine sees no props
change at all.

## 8. Watch the output cross

`feature.run` collects outputs in their own array. They are never folded back
into the reducer.

```ts continue
const saved = await Effect.runPromise(
  editor.run([SaveClicked.make({})], {
    props: { noteId: "n1", initialText: "Buy milk" },
    hooks: {},
    layer: notesApiLayer,
  }),
);

console.log(saved.emitted.map((action) => action._tag));
// => ["SaveResolved"]
console.log(saved.outputs.map((output) => output._tag));
// => ["Saved"]
console.log(saved.state.dirty);
// => false
```

`SaveResolved` is an action, so it appears in `emitted` and changed the state.
`Saved` is an output, so it appears in `outputs` and changed nothing.

## The files

```sh
src/
  notes-api.ts     # list and save
  runtime.ts       # createRuntime(notesApiLayer)
  note-editor.tsx  # the child feature, with its Saved output
  note-list.tsx    # the parent feature and its view fragment
  main.tsx         # the mount
```

Split across the files, the imports between them are:

```ts fragment
import { notesApiLayer } from "./notes-api"; // runtime.ts
import { Note, NotesApi } from "./notes-api"; // note-editor.tsx and note-list.tsx
import { component } from "./runtime"; // note-editor.tsx and note-list.tsx
import { NoteEditor } from "./note-editor"; // note-list.tsx
import { NoteList } from "./note-list"; // main.tsx
```

## Next

You have the whole model: schemas, actions, outputs, a pure reducer, commands,
tasks, and composition.

- [Actions and outputs](/docs/explanation/actions-and-outputs): why the two
  channels never mix.
- [Children and opaque props](/docs/explanation/children-and-opaque-props): what
  `Children` costs you.
- [Test a feature without React](/docs/how-to/test-a-feature-without-react):
  `reduce` and `run` in a test file.
- [Install devtools](/docs/how-to/install-devtools): see every transition,
  command and output.
