import { Effect, Schema } from "effect";
import { Action, Command, Task, define } from "@wych/react";
import { NotesApi } from "./notes-api";
import { component } from "./runtime";

const TextChanged = Action("TextChanged", { text: Schema.String });
const Reverted = Action("Reverted", {});
export const SaveClicked = Action("SaveClicked", {});
const Saved = Action.output("Saved", { id: Schema.String, revision: Schema.String });

const saveNote = Task("Save", {
  success: Schema.String,
  onError: Task.message,
  run: (note: { readonly id: string; readonly text: string }) =>
    Effect.gen(function* () {
      const api = yield* NotesApi;
      return yield* api.save(note);
    }),
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

export const editor = Editor.create({
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
      Task.isPending(state.save)
        ? state
        : Task.start(state, "save", saveNote.run({ id: props.noteId, text: state.text })),
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
      <button type="button" disabled={!state.dirty} onClick={() => dispatch(Reverted.make({}))}>
        Revert
      </button>
      <button type="button" onClick={() => dispatch(SaveClicked.make({}))}>
        Save
      </button>
    </form>
  ),
});

export const NoteEditor = component(editor, { name: "NoteEditor" });
