import { Effect, Schema } from "effect";
import { Action, Children, Task, define } from "@wych/react";
import { NoteEditor } from "./note-editor";
import { Note, NotesApi } from "./notes-api";
import { component } from "./runtime";

const NoteSaved = Action("NoteSaved", { id: Schema.String, revision: Schema.String });

const loadNotes = Task("Load", {
  success: Schema.Array(Note),
  onError: Task.message,
  run: () =>
    Effect.gen(function* () {
      const api = yield* NotesApi;
      return yield* api.list;
    }),
});

const List = define({
  props: Schema.Struct({ title: Schema.String, children: Schema.optionalKey(Children) }),
  state: Schema.Struct({
    notes: Task.schema(Schema.Array(Note)),
    lastSaved: Schema.String,
  }),
  action: Action.of([NoteSaved, ...loadNotes.actions]),
});

const listReducer = List.reducer({
  Mounted: (_payload, { state }) => Task.start(state, "notes", loadNotes.run()),
  NoteSaved: ({ id }, { state }) => ({ ...state, lastSaved: id }),
  LoadResolved: ({ value }, { state }) => ({ ...state, notes: Task.resolved(value) }),
  LoadRejected: ({ error }, { state }) => ({ ...state, notes: Task.rejected(error) }),
});

const LastSaved = () => {
  const { state } = NoteList.useFeature();
  return state.lastSaved === "" ? null : <footer>Last saved: {state.lastSaved}</footer>;
};

const noteList = List.create({
  initialState: () => ({ notes: Task.idle, lastSaved: "" }),
  reducer: listReducer,
  render: ({ state, props, dispatch }) => (
    <section>
      <h1>{props.title}</h1>
      {Task.match(state.notes, {
        Idle: () => null,
        Pending: () => <p>Loading notes...</p>,
        Rejected: ({ error }) => <p role="alert">{error}</p>,
        Resolved: ({ value }) => (
          <ul>
            {value.map((note) => (
              <li key={note.id}>
                <NoteEditor
                  noteId={note.id}
                  initialText={note.text}
                  onSaved={({ id, revision }) => dispatch(NoteSaved.make({ id, revision }))}
                />
              </li>
            ))}
          </ul>
        ),
      })}
      <LastSaved />
      {props.children}
    </section>
  ),
});

export const NoteList = component(noteList, { name: "NoteList" });
