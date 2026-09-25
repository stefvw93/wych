import { Cause, Effect, Schema } from "effect";
import { Action, Command, define } from "@wych/react";
import { NotesApi } from "./notes-api";
import { component } from "./runtime";

// The save written with a bare Command, before Task folds the parts in.
// `note-editor.tsx` is the same feature with Task; `note-editor.test.ts`
// runs the same sequences through both.

export const actions = Action({
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
  actions,
});

const initialState = ByHand.initialState((props) => ({
  text: props.initialText,
  dirty: false,
  saving: false,
  error: "",
}));

const reducer = ByHand.reducer({
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
  // A save already pending is ignored: the rule lives in the handler, not
  // in the disabled button.
  SaveClicked: (_payload, { draft, state, props }) => {
    if (state.saving) return draft;
    draft.saving = true;
    draft.error = "";
    return [
      draft,
      Command.effect((dispatch) =>
        Effect.gen(function* () {
          const api = yield* NotesApi;
          const revision = yield* api.save({ id: props.noteId, text: state.text });
          yield* dispatch(actions.Saved, { revision });
        }).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            const message = error instanceof Error ? error.message : String(error);
            return dispatch(actions.SaveFailed, { message });
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

const render = ByHand.render(({ state, dispatch }) => (
  <form>
    <textarea
      value={state.text}
      onChange={(event) => dispatch(actions.TextChanged, { text: event.target.value })}
    />
    <button type="button" disabled={!state.dirty} onClick={() => dispatch(actions.Reverted)}>
      Revert
    </button>
    <button type="button" disabled={state.saving} onClick={() => dispatch(actions.SaveClicked)}>
      {state.saving ? "Saving..." : "Save"}
    </button>
    {state.error !== "" && <span role="alert">{state.error}</span>}
  </form>
));

export const byHand = ByHand.create({ initialState, reducer, render });

export const NoteEditorByHand = component(byHand, { name: "NoteEditorByHand" });
