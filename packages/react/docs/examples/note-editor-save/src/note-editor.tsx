import { Effect, Schema } from "effect";
import { Action, Task, define } from "@wych/react";
import { NotesApi } from "./notes-api";
import { component } from "./runtime";

const saveNote = Task("Save", {
  success: Schema.String,
  onError: Task.errorMessage,
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
  SaveClicked: (_payload, { draft, state, props }) =>
    Task.isPending(state.save)
      ? draft
      : Task.start(draft, "save", saveNote.run({ id: props.noteId, text: state.text })),
  SaveCancelled: (_payload, { draft }) => {
    draft.save = Task.idle;
    return [draft, saveNote.cancel];
  },
  SaveResolved: ({ value }, { draft }) => {
    draft.dirty = false;
    draft.save = Task.resolved(value);
    return draft;
  },
  SaveRejected: ({ error }, { draft }) => {
    draft.save = Task.rejected(error);
    return draft;
  },
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
