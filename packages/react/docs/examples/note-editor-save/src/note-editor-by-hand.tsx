import { Cause, Effect, Schema } from "effect";
import { Action, Command, define } from "@wych/react";
import { NotesApi } from "./notes-api";
import { component } from "./runtime";

// The save written with a bare Command, before Task folds the parts in.
// `note-editor.tsx` is the same feature with Task; `note-editor.test.ts`
// runs the same sequences through both.

const TextChanged = Action("TextChanged", { text: Schema.String });
const Reverted = Action("Reverted", {});
export const SaveClicked = Action("SaveClicked", {});
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

const initialState = ByHand.initialState((props) => ({
  text: props.initialText,
  dirty: false,
  saving: false,
  error: "",
}));

const reducer = ByHand.reducer({
  TextChanged: ({ text }, { state, props }) => ({
    ...state,
    text,
    dirty: text !== props.initialText,
  }),
  Reverted: (_payload, { state, props }) => ({ ...state, text: props.initialText, dirty: false }),
  // A save already pending is ignored: the rule lives in the handler, not
  // in the disabled button.
  SaveClicked: (_payload, { state, props }) =>
    state.saving
      ? state
      : [
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

const render = ByHand.render(({ state, dispatch }) => (
  <form>
    <textarea
      value={state.text}
      onChange={(event) => dispatch(TextChanged.make({ text: event.target.value }))}
    />
    <button type="button" disabled={!state.dirty} onClick={() => dispatch(Reverted.make({}))}>
      Revert
    </button>
    <button type="button" disabled={state.saving} onClick={() => dispatch(SaveClicked.make({}))}>
      {state.saving ? "Saving..." : "Save"}
    </button>
    {state.error !== "" && <span role="alert">{state.error}</span>}
  </form>
));

export const byHand = ByHand.create({ initialState, reducer, render });

export const NoteEditorByHand = component(byHand, { name: "NoteEditorByHand" });
