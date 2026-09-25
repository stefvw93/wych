import { Schema } from "effect";
import { Action, define } from "@wych/react";
import { component } from "./runtime";

export const actions = Action({ TextChanged: { text: Schema.String }, Reverted: {} });

const Editor = define({
  props: Schema.Struct({ noteId: Schema.String, initialText: Schema.String }),
  state: Schema.Struct({ text: Schema.String, dirty: Schema.Boolean }),
  actions,
});

const initialState = Editor.initialState((props) => ({
  text: props.initialText,
  dirty: false,
}));

const reducer = Editor.reducer({
  TextChanged: (payload, snapshot) => {
    snapshot.draft.text = payload.text;
    snapshot.draft.dirty = payload.text !== snapshot.props.initialText;
    return snapshot.draft;
  },
  Reverted: (_payload, snapshot) => {
    snapshot.draft.text = snapshot.props.initialText;
    snapshot.draft.dirty = false;
    return snapshot.draft;
  },
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
  </form>
));

export const editor = Editor.create({ initialState, reducer, render });

export const NoteEditor = component(editor, { name: "NoteEditor" });
