import { Effect, Schema } from "effect";
import { Action, Task, define } from "@wych/react";
import { NotesApi } from "./notes-api";
import { component } from "./runtime";

const saveNote = Task("Save", {
  success: Schema.String,
  run: (note: { readonly id: string; readonly text: string }) =>
    Effect.gen(function* () {
      const api = yield* NotesApi;
      return yield* api.save(note);
    }),
});

export const actions = Action({
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
    save: saveNote.schema,
  }),
  action: [actions, saveNote],
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
  ...saveNote.into("save"),
  SaveResolved: saveNote.resolvedInto("save", (_revision, { draft }) => {
    draft.dirty = false;
    return draft;
  }),
});

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

export const editor = Editor.create({ initialState, reducer, render });

export const NoteEditor = component(editor, { name: "NoteEditor" });
