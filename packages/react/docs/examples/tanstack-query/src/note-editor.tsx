import { useQuery } from "@tanstack/react-query";
import { Action, Command, define, Task } from "@wych/react";
import { Effect, Schema } from "effect";
import { fetchNote, saveNote } from "./api";
import { Queries } from "./queries";

export const noteKey = (id: string) => ["note", id] as const;

export const actions = Action({ Typed: { text: Schema.String }, Submitted: {} });
export const Saved = Action.output("Saved", { id: Schema.String });

/**
 * Write path: the save runs as a task against the `Queries` service. On
 * success it invalidates the note's key, so every `useQuery` on it refetches.
 */
export const save = Task("Save", {
  success: Schema.String,
  run: ({ id, text }: { id: string; text: string }) =>
    Effect.gen(function* () {
      const client = yield* Queries;
      const note = yield* Effect.tryPromise({
        try: () => saveNote(id, text),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
      yield* Effect.promise(() => client.invalidateQueries({ queryKey: noteKey(id) }));
      return note.text;
    }),
});

// `tasks: { save }` gives the task the `save` state field: it starts `Idle`,
// `start` writes `Pending`, and the fold writes the settle into it.
export const noteEditor = define({
  props: Schema.Struct({ noteId: Schema.String }),
  state: Schema.Struct({ draft: Schema.String }),
  tasks: { save },
  actions,
  outputs: Saved,
  /**
   * Read path: `useQuery` runs in render position. Only primitives are
   * returned, because hooks are compared per key with `Object.is`; the result
   * object itself is new on every render.
   */
  useUnsafeHooks: (props) => {
    const query = useQuery({
      queryKey: noteKey(props.noteId),
      queryFn: () => fetchNote(props.noteId),
    });
    return { text: query.data?.text, status: query.status };
  },
}).create({
  initialState: () => ({ draft: "" }),
  reducer: {
    // The cache filled or refetched: adopt the server text as the draft.
    HookChanged: ({ previous }, { draft, hooks }) => {
      if (hooks.text === undefined || hooks.text === previous.text) return draft;
      draft.draft = hooks.text;
      return draft;
    },
    Typed: ({ text }, { draft }) => {
      draft.draft = text;
      return draft;
    },
    Submitted: (_payload, { state, props, tasks }) =>
      tasks.save.start({ id: props.noteId, text: state.draft }),
    // The saved text is already in `save` when this runs: adopt it as the
    // draft, then the parent hears about it. A rejection needs no handler.
    SaveResolved: ({ value }, { draft, props }) => {
      draft.draft = value;
      return [draft, Command.output(Saved, { id: props.noteId })];
    },
  },
  render: ({ state, hooks, dispatch }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        dispatch(actions.Submitted);
      }}
    >
      {hooks.status === "pending" && <p>Loading</p>}
      {hooks.status === "error" && <p>Could not load the note</p>}
      <textarea
        value={state.draft}
        disabled={hooks.status !== "success"}
        onChange={(event) => dispatch(actions.Typed, { text: event.target.value })}
      />
      <button type="submit" disabled={Task.isPending(state.save)}>
        {Task.isPending(state.save) ? "Saving" : "Save"}
      </button>
      {Task.match(state.save, {
        Idle: () => null,
        Pending: () => null,
        Resolved: () => <p>Saved</p>,
        Rejected: ({ error }) => <p>{error}</p>,
      })}
    </form>
  ),
});
