import { Effect, Schema } from "effect";
import { Action, Command, Task, define } from "@wych/react";
import { NotesApi } from "./notes-api";
import { component } from "./runtime";

export const actions = Action({
  TextChanged: { text: Schema.String },
  Reverted: {},
  SaveClicked: {},
});
const outputs = Action.output({ Saved: { id: Schema.String, revision: Schema.String } });

const saveNote = Task("Save", {
  success: Schema.String,
  mode: "first",
  run: (note: { readonly id: string; readonly text: string }) =>
    Effect.gen(function* () {
      const api = yield* NotesApi;
      return yield* api.save(note);
    }),
});

const Editor = define({
  props: Schema.Struct({ noteId: Schema.String, initialText: Schema.String }),
  state: Schema.Struct({ text: Schema.String, dirty: Schema.Boolean }),
  tasks: { save: saveNote },
  actions,
  outputs,
});

export const editor = Editor.create({
  initialState: (props) => ({ text: props.initialText, dirty: false }),
  reducer: {
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
    SaveResolved: ({ value }, { draft, props }) => {
      draft.dirty = false;
      return [draft, Command.output(outputs.Saved, { id: props.noteId, revision: value })];
    },
  },
  render: ({ state, dispatch }) => (
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
    </form>
  ),
});

export const NoteEditor = component(editor, { name: "NoteEditor" });
