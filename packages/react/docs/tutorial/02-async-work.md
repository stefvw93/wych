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
problems every save button has, and a `Task` in the `tasks` slot folds the
fixes into one field.

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

const byHandActions = Action({
  TextChanged: { text: Schema.String },
  Reverted: {},
  SaveClicked: {},
  Saved: { revision: Schema.String },
  SaveFailed: { message: Schema.String },
});

const ByHand = define({
  props: Schema.Struct({ noteId: Schema.String, initialText: Schema.String }),
  state: Schema.Struct({
    text: Schema.String,
    dirty: Schema.Boolean,
    saving: Schema.Boolean,
    error: Schema.String,
  }),
  actions: byHandActions,
});

const byHandInitialState = ByHand.initialState((props) => ({
  text: props.initialText,
  dirty: false,
  saving: false,
  error: "",
}));

const byHandReducer = ByHand.reducer({
  TextChanged: ({ text }, { draft, props }) => {
    draft.text = text;
    draft.dirty = text !== props.initialText;
    return draft;
  },
  Reverted: (_payload, { draft, props }) => {
    draft.text = props.initialText;
    draft.dirty = false;
    return draft;
  },
  SaveClicked: (_payload, { draft, state, props }) => {
    draft.saving = true;
    draft.error = "";
    return [
      draft,
      Command.effect((dispatch) =>
        Effect.gen(function* () {
          const api = yield* NotesApi;
          const revision = yield* api.save({ id: props.noteId, text: state.text });
          yield* dispatch(byHandActions.Saved, { revision });
        }).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            const message = error instanceof Error ? error.message : String(error);
            return dispatch(byHandActions.SaveFailed, { message });
          }),
        ),
      ),
    ];
  },
  Saved: (_payload, { draft }) => {
    draft.saving = false;
    draft.dirty = false;
    return draft;
  },
  SaveFailed: ({ message }, { draft }) => {
    draft.saving = false;
    draft.error = message;
    return draft;
  },
});

const byHandRender = ByHand.render(({ state, dispatch }) => (
  <form>
    <textarea
      value={state.text}
      onChange={(event) => dispatch(byHandActions.TextChanged, { text: event.target.value })}
    />
    <button
      type="button"
      disabled={state.saving}
      onClick={() => dispatch(byHandActions.SaveClicked)}
    >
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
actions, so a message from another feature or a wrong payload is a compile
error.

`feature.run` folds a list of actions, runs every command against a layer
you choose, and folds what the commands dispatch back. No React in the path.
A seed is a built message, and `make` needs no argument when the message has
no fields.

```ts continue
const stubSave = Layer.succeed(NotesApi)({
  save: (note) => Effect.succeed(`${note.id}@1`),
});

const oneSave = await Effect.runPromise(
  byHand.run([byHandActions.SaveClicked.make()], {
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
  byHand.run([byHandActions.SaveClicked.make(), byHandActions.SaveClicked.make()], {
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
  guarded.run([byHandActions.SaveClicked.make(), byHandActions.SaveClicked.make()], {
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
result actions, the command, the failure mapping and the state field, from a
name and a schema of what the work returns.

```ts continue
import { Task } from "@wych/react";

const saveNote = Task("Save", {
  success: Schema.String,
  mode: "first",
  run: (note: { readonly id: string; readonly text: string }) =>
    Effect.gen(function* () {
      const api = yield* NotesApi;
      return yield* api.save(note);
    }),
});
```

Each piece replaces something from step 3 or 4:

- `saveNote` declares `SaveResolved { value }` and `SaveRejected { error }`,
  in place of `Saved` and `SaveFailed`.
- `saveNote.run(note)` is the `Command.effect` with `catchCause` inside.
- The `catchCause` body is `Task.errorMessage`, the message off the cause. It
  is the default; a `failure` schema of your own takes an `onError` beside it.
- `mode: "first"` is the guard from step 4: while a save is pending, a new
  start does nothing.
- `saveNote.cancel` interrupts the save in flight. By hand that needs a named
  group; see [groups and cancellation](/docs/explanation/groups-and-cancellation).

The state field, in place of `saving` and `error`, comes from the `tasks`
slot on `define`. The key names the field.

```ts continue
const actions = Action({
  TextChanged: { text: Schema.String },
  Reverted: {},
  SaveClicked: {},
  SaveCancelled: {},
});

const Editor = define({
  props: Schema.Struct({ noteId: Schema.String, initialText: Schema.String }),
  state: Schema.Struct({
    text: Schema.String,
    dirty: Schema.Boolean,
  }),
  tasks: { save: saveNote },
  actions,
});

const initialState = Editor.initialState((props) => ({
  text: props.initialText,
  dirty: false,
}));
```

`tasks: { save: saveNote }` adds a `save` field to the state and brings the
two actions with it. The field holds one of four cases: `Idle`, `Pending`,
`Resolved { value }`, `Rejected { error }`. It starts `Idle`, so
`initialState` leaves it out.

```ts continue
const reducer = Editor.reducer({
  TextChanged: ({ text }, { draft, props }) => {
    draft.text = text;
    draft.dirty = text !== props.initialText;
    draft.save = Task.idle;
    return draft;
  },
  Reverted: (_payload, { draft, props }) => {
    draft.text = props.initialText;
    draft.dirty = false;
    draft.save = Task.idle;
    return draft;
  },
  SaveClicked: (_payload, { state, props, tasks }) =>
    tasks.save.start({ id: props.noteId, text: state.text }),
  SaveCancelled: (_payload, { tasks }) => tasks.save.cancel(),
  SaveResolved: (_payload, { draft }) => {
    draft.dirty = false;
    return draft;
  },
});
```

The snapshot carries one handle per key of the slot, under `tasks`.
`tasks.save.start(note)` writes `Pending` into `save` and returns the draft
beside the command, the same two lines `SaveClicked` wrote by hand. Under
`mode: "first"`, a start while the field is `Pending` writes nothing and
issues `Command.none`. `tasks.save.cancel()` writes `Idle` and interrupts the
save.

When the save settles, the runtime writes `Resolved { value }` or
`Rejected { error }` into `save` before any handler runs. So the reducer
owes no handler for `SaveResolved` and `SaveRejected`. A resolved save also
clears `dirty`, and that is what the `SaveResolved` handler above is for:
the draft already holds the settled field, and the handler adds its own
write.

> A settle handler receives the payload like any other handler:
> `SaveResolved: ({ value }, { draft }) => …`. Interruption is a normal ending
> for a task: a cancelled save dispatches neither `SaveResolved` nor
> `SaveRejected`. The full contract of the slot and its handles is in
> [Tasks](/docs/reference/tasks).

## 6. Render the four cases

The field holds one of four cases, and the view has to handle each one.
`Task.match` takes the field and one function per case, and is exhaustive: a
missing case does not compile.

```tsx continue
const render = Editor.render(({ state, dispatch }) => (
  <form>
    <textarea
      value={state.text}
      onChange={(event) => dispatch(actions.TextChanged, { text: event.target.value })}
    />
    <button type="button" disabled={!state.dirty} onClick={() => dispatch(actions.Reverted)}>
      Revert
    </button>
    <button type="button" onClick={() => dispatch(actions.SaveClicked)}>
      Save
    </button>
    <button type="button" onClick={() => dispatch(actions.SaveCancelled)}>
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
  editor.run([actions.SaveClicked.make(), actions.SaveClicked.make()], {
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

> `mode` is declared once on the operation. `"first"` sends the first request
> and ignores the second, which is what a save wants. The default `"latest"`
> interrupts the running request when a new one starts, so the second click
> wins; a search wants that. `"every"`, where both requests land in order, is
> in [debounce and take latest](/docs/how-to/debounce-and-take-latest); the
> option is in [tasks](/docs/reference/tasks#taskmode).

A settle is an action, so `feature.reduce` folds one on its own.
`saveNote.Resolved` builds it, and the state includes the field.

```ts continue
import { Next } from "@wych/react";

const settled = editor.reduce(saveNote.Resolved.make({ value: "n1@3" }), {
  state: { text: "Buy milk", dirty: true, save: Task.pending },
  props: { noteId: "n1", initialText: "Buy milk" },
  hooks: {},
});

console.log(Next.state(settled));
// => { text: "Buy milk", dirty: false, save: { _tag: "Resolved", value: "n1@3" } }
```

The field was written by the runtime, `dirty` by the handler, on one fold.

A failing layer lands in the same field, with the message `Task.errorMessage`
took off the cause.

```ts continue
const failingSave = Layer.succeed(NotesApi)({
  save: () => Effect.fail(new Error("offline")),
});

const failed = await Effect.runPromise(
  editor.run([actions.SaveClicked.make()], {
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
  editor.run([actions.SaveClicked.make(), actions.SaveCancelled.make()], {
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
import { actions, editor, saveNote } from "./note-editor"; // note-editor.test.ts
import { actions as byHandActions, byHand } from "./note-editor-by-hand"; // note-editor.test.ts
```

## Next

One editor saves one note. A list that mounts many editors, and hears about
every save, is [chapter 3](/docs/tutorial/composing-features).

For every option on `Task`, including `mode: "every"` and a `failure` schema
with its `onError`, see [Tasks](/docs/reference/tasks). For the command
constructors underneath it, see [Commands](/docs/reference/commands).

Every command in this chapter completes: a save returns or fails, and `run`
resolves once nothing is in flight. A source that never completes, such as a
websocket, a presence feed or a `Stream.tick`, is a subscription, not a
command. The feature declares it under a key, and the runtime starts and
stops it as the key changes. That recipe is
[subscribe to a stream](/docs/how-to/subscribe-to-a-stream).
