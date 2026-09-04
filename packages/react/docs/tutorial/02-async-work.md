---
title: Async work
description: Save the note through an Effect service. First by hand with a Command, then with Task.
order: 2
example: note-editor-save
---

# Async work

The editor from [chapter 1](/docs/tutorial/your-first-feature) holds text and
nothing else. Saving it needs a service to call, a way to run the call, and
somewhere to put the outcome.

You write the save by hand first, with a `Command`. Then you hit the two
problems every save button has, and `Task` folds the fixes into one field.

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

## 3. Save by hand

A handler cannot call the service. It returns a `Command` that describes the
call, and the runtime runs it. `Command.effect` takes a function of
`dispatch`: the effect does its work, then dispatches an action with the
result.

```tsx continue
// note-editor.tsx
import { Cause, Schema } from "effect";
import { Action, Command, define } from "@wych/react";

const TextChanged = Action("TextChanged", { text: Schema.String });
const Reverted = Action("Reverted", {});
const SaveClicked = Action("SaveClicked", {});
const Saved = Action("Saved", { revision: Schema.String });
const SaveFailed = Action("SaveFailed", { message: Schema.String });

const ByHand = define({
  props: Schema.Struct({ noteId: Schema.String, initialText: Schema.String }),
  state: Schema.Struct({
    text: Schema.String,
    dirty: Schema.Boolean,
    saving: Schema.Boolean,
    error: Schema.String,
  }),
  action: Action.of([TextChanged, Reverted, SaveClicked, Saved, SaveFailed]),
});

const byHandInitialState = ByHand.initialState((props) => ({
  text: props.initialText,
  dirty: false,
  saving: false,
  error: "",
}));

const byHandReducer = ByHand.reducer({
  TextChanged: ({ text }, { state, props }) => ({
    ...state,
    text,
    dirty: text !== props.initialText,
  }),
  Reverted: (_payload, { state, props }) => ({ ...state, text: props.initialText, dirty: false }),
  SaveClicked: (_payload, { state, props }) => [
    { ...state, saving: true, error: "" },
    Command.effect((dispatch) =>
      Effect.gen(function* () {
        const api = yield* NotesApi;
        const revision = yield* api.save({ id: props.noteId, text: state.text });
        yield* dispatch(Saved.make({ revision }));
      }).pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          const message = error instanceof Error ? error.message : String(error);
          return dispatch(SaveFailed.make({ message }));
        }),
      ),
    ),
  ],
  Saved: (_payload, { state }) => ({ ...state, saving: false, dirty: false }),
  SaveFailed: ({ message }, { state }) => ({ ...state, saving: false, error: message }),
});

const byHandRender = ByHand.render(({ state, dispatch }) => (
  <form>
    <textarea
      value={state.text}
      onChange={(event) => dispatch(TextChanged.make({ text: event.target.value }))}
    />
    <button type="button" disabled={state.saving} onClick={() => dispatch(SaveClicked.make({}))}>
      {state.saving ? "Saving..." : "Save"}
    </button>
    {state.error !== "" && <span role="alert">{state.error}</span>}
  </form>
));

const byHand = ByHand.create({
  initialState: byHandInitialState,
  reducer: byHandReducer,
  render: byHandRender,
});
```

Three things to notice. `saving: true` is written on the same fold that
returns the command, so the button is disabled before the click handler
returns. The effect reads like a function body: get the service, call it,
dispatch the result. Its error channel must be `never`, which is what
`catchCause` is for: every failure becomes a `SaveFailed` action the reducer
can render. And `dispatch` inside the effect is typed to this feature's
actions, so a typo in `Saved` is a compile error.

`feature.run` folds a list of actions, runs every command against a layer
you choose, and folds what the commands dispatch back. No React in the path.

```ts continue
const stubSave = Layer.succeed(NotesApi)({
  save: (note) => Effect.succeed(`${note.id}@1`),
});

const oneSave = await Effect.runPromise(
  byHand.run([SaveClicked.make({})], {
    props: { noteId: "n1", initialText: "Buy milk" },
    hooks: {},
    layer: stubSave,
  }),
);

console.log(oneSave.emitted);
// => [{ _tag: "Saved", revision: "n1@1" }]
console.log(oneSave.state.saving);
// => false
```

> `emitted` holds what the commands dispatched. The `SaveClicked` you seeded
> is folded but never appears there.

## 4. Two clicks, two requests

Make the stub slow enough that the first save is still in flight when the
second click arrives.

```ts continue
const slowSave = Layer.succeed(NotesApi)({
  save: (note) =>
    Effect.gen(function* () {
      yield* Effect.sleep("50 millis");
      return `${note.id}@2`;
    }),
});

const twoByHand = await Effect.runPromise(
  byHand.run([SaveClicked.make({}), SaveClicked.make({})], {
    props: { noteId: "n1", initialText: "Buy milk" },
    hooks: {},
    layer: slowSave,
  }),
);

console.log(twoByHand.emitted.map((action) => action._tag));
// => ["Saved", "Saved"]
```

Two requests went out. The disabled button would have stopped a real user,
but nothing in the reducer did, and a keyboard shortcut or a retry loop does
not read the button. The rule belongs in the handler: a save that is already
pending is ignored.

```ts continue
const guarded = ByHand.create({
  initialState: byHandInitialState,
  reducer: {
    ...byHandReducer,
    SaveClicked: (payload, snapshot) =>
      snapshot.state.saving ? snapshot.state : byHandReducer.SaveClicked(payload, snapshot),
  },
  render: byHandRender,
});

const twoGuarded = await Effect.runPromise(
  guarded.run([SaveClicked.make({}), SaveClicked.make({})], {
    props: { noteId: "n1", initialText: "Buy milk" },
    hooks: {},
    layer: slowSave,
  }),
);

console.log(twoGuarded.emitted.map((action) => action._tag));
// => ["Saved"]
```

That is the first problem. The second is the state itself: `saving` and
`error` are two fields that can disagree. Nothing stops `saving: true` next
to a stale error, and there is no place for the revision the save returned.
A save has four outcomes, and two booleans cannot spell four cases.

## 5. The same thing as a Task

`Task` is the by-hand version with the parts folded in. It declares the two
result actions, the command, and the failure mapping, from a name and a
schema of what the work returns.

```ts continue
import { Task } from "@wych/react";

const saveNote = Task("Save", {
  success: Schema.String,
  onError: Task.message,
  run: (note: { readonly id: string; readonly text: string }) =>
    Effect.gen(function* () {
      const api = yield* NotesApi;
      return yield* api.save(note);
    }),
});
```

Each piece replaces something from step 3:

- `saveNote.actions` is `SaveResolved { value }` and `SaveRejected { error }`,
  in place of `Saved` and `SaveFailed`.
- `saveNote.run(note)` is the `Command.effect` with `catchCause` inside.
- `Task.message` is the `catchCause` body: the message off the cause.
- `saveNote.cancel` interrupts the save in flight. By hand that needs a named
  group; see [groups and cancellation](/docs/explanation/groups-and-cancellation).

The state field replaces `saving` and `error`. `Task.schema` holds one of
four cases: `Idle`, `Pending`, `Resolved { value }`, `Rejected { error }`.

```ts continue
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

The two generated actions are spread into the vocabulary beside the ones you
wrote. The reducer now owes a handler for each.

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
    Task.isPending(state.save)
      ? state
      : Task.start(state, "save", saveNote.run({ id: props.noteId, text: state.text })),
  SaveCancelled: (_payload, { state }) => [{ ...state, save: Task.idle }, saveNote.cancel],
  SaveResolved: ({ value }, { state }) => ({
    ...state,
    dirty: false,
    save: Task.resolved(value),
  }),
  SaveRejected: ({ error }, { state }) => ({ ...state, save: Task.rejected(error) }),
});
```

`Task.start(state, key, command)` writes `Pending` into `key` and returns
the command beside it, the same two lines `SaveClicked` wrote by hand. The
guard is the one from step 4, reading the field instead of a boolean.
`saveNote.cancel` writes nothing, which is why the same handler clears the
field.

> `key` is checked against the state's task fields, so a renamed field is a
> compile error. Interruption is a normal ending for a task: a cancelled save
> dispatches neither `SaveResolved` nor `SaveRejected`.

## 6. Render the four cases

The field holds one of four cases, and the view has to handle each one.
`Task.match` takes the field and one function per case, and is exhaustive: a
missing case does not compile.

```tsx continue
const render = Editor.render(({ state, dispatch }) => (
  <form>
    <textarea
      value={state.text}
      onChange={(event) => dispatch(TextChanged.make({ text: event.target.value }))}
    />
    <button type="button" disabled={!state.dirty} onClick={() => dispatch(Reverted.make({}))}>
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

Each function receives its whole case, so `Resolved` reads `value` and
`Rejected` reads `error`. The four may return different types.

## 7. Mount it

`main.tsx` is unchanged from chapter 1.

```tsx continue
const editor = Editor.create({ initialState, reducer, render });

export const NoteEditor = component(editor, { name: "NoteEditor" });
```

Press Save and the label reads `Saving...`, then `Saved as n1@...`. The
revision comes from the stub layer.

## 8. The same tests, through Task

Two clicks still produce one save, and the outcome now lands in the field.

```ts continue
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

> `Task` has a concurrency `mode`, declared once on the operation. The default
> `"latest"` interrupts the running request when a new one starts, so even
> without the guard two clicks resolve once. The difference is which click
> wins: `"latest"` sends the second request and drops the first mid-flight,
> the guard sends the first and ignores the second. A search wants the former;
> a save wants the latter, and take-first is a guard because it reads state.
> `"every"`, where both requests land in order, is in
> [debounce and take latest](/docs/how-to/debounce-and-take-latest); the
> option is in [tasks](/docs/reference/tasks).

A failing layer lands in the same field, with the message `Task.message`
took off the cause.

```ts continue
const failingSave = Layer.succeed(NotesApi)({
  save: () => Effect.fail(new Error("offline")),
});

const failed = await Effect.runPromise(
  editor.run([SaveClicked.make({})], {
    props: { noteId: "n1", initialText: "Buy milk" },
    hooks: {},
    layer: failingSave,
  }),
);

console.log(failed.state.save);
// => { _tag: "Rejected", error: "offline" }
```

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
  main.tsx                 # mounts both editors
  note-editor-by-hand.tsx  # step 3 and 4: Command.effect, the guard
  note-editor.tsx          # step 5 to 7: the Task version
  note-editor.test.ts      # steps 4, 8 and 9 as vitest tests
  notes-api.ts             # the NotesApi service and its layer
  runtime.ts               # createRuntime(notesApiLayer)
```

Split across the files, the imports between them are:

```ts fragment
import { notesApiLayer } from "./notes-api"; // runtime.ts
import { NotesApi } from "./notes-api"; // note-editor.tsx, note-editor-by-hand.tsx
import { component } from "./runtime"; // note-editor.tsx, note-editor-by-hand.tsx
import { NoteEditor } from "./note-editor"; // main.tsx
import { editor, SaveCancelled, SaveClicked } from "./note-editor"; // note-editor.test.ts
```

## Next

One editor saves one note. A list that mounts many editors, and hears about
every save, is [chapter 3](/docs/tutorial/composing-features).

For every option on `Task`, including `mode: "every"` and a typed failure
schema, see [Tasks](/docs/reference/tasks). For the command constructors
underneath it, see [Commands](/docs/reference/commands).
