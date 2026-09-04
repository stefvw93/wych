import { Effect, Schema } from "effect";
import { Action, Task, define } from "@wych/react";
import { NotesApi } from "./notes-api";
import { component } from "./runtime";

const saveNote = Task("Save", {
  success: Schema.String,
  onError: Task.message,
  run: (note: { readonly id: string; readonly text: string }) =>
    Effect.gen(function* () {
      const api = yield* NotesApi;
      return yield* api.save(note);
    }),
});

const TextChanged = Action("TextChanged", { text: Schema.String });
const Reverted = Action("Reverted", {});
export const SaveClicked = Action("SaveClicked", {});
export const SaveCancelled = Action("SaveCancelled", {});

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

export const editor = Editor.create({ initialState, reducer, render });

export const NoteEditor = component(editor, { name: "NoteEditor" });
