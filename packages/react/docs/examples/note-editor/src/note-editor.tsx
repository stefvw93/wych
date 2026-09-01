import { Schema } from "effect";
import { Action, define } from "@wych/react";
import { component } from "./runtime";

export const TextChanged = Action("TextChanged", { text: Schema.String });
const Reverted = Action("Reverted", {});

const Editor = define({
  props: Schema.Struct({ noteId: Schema.String, initialText: Schema.String }),
  state: Schema.Struct({ text: Schema.String, dirty: Schema.Boolean }),
  action: Action.of([TextChanged, Reverted]),
});

const initialState = Editor.initialState((props) => ({
  text: props.initialText,
  dirty: false,
}));

const reducer = Editor.reducer({
  TextChanged: ({ text }, { props }) => ({ text, dirty: text !== props.initialText }),
  Reverted: (_payload, { props }) => ({ text: props.initialText, dirty: false }),
});

const render = Editor.render(({ state, dispatch }) => (
  <form>
    <textarea
      value={state.text}
      onChange={(event) => dispatch(TextChanged.make({ text: event.target.value }))}
    />
    <button type="button" disabled={!state.dirty} onClick={() => dispatch({ _tag: "Reverted" })}>
      Revert
    </button>
  </form>
));

export const editor = Editor.create({ initialState, reducer, render });

export const NoteEditor = component(editor, { name: "NoteEditor" });
