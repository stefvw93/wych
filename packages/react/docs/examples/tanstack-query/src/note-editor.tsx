import { useQuery } from "@tanstack/react-query";
import { Action, Command, define, Task } from "@wych/react";
import { Effect, Schema } from "effect";
import { fetchNote, saveNote } from "./api";
import { Queries } from "./queries";

export const noteKey = (id: string) => ["note", id] as const;

export const Typed = Action("Typed", { text: Schema.String });
export const Submitted = Action("Submitted", {});
export const Saved = Action.output("Saved", { id: Schema.String });

/**
 * Write path: the save runs as a task against the `Queries` service. On
 * success it invalidates the note's key, so every `useQuery` on it refetches.
 */
export const save = Task("Save", {
  success: Schema.String,
  onError: Task.message,
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

export const noteEditor = define({
  props: Schema.Struct({ noteId: Schema.String }),
  state: Schema.Struct({ draft: Schema.String, save: Task.schema(Schema.String) }),
  action: Action.of([Typed, Submitted, ...save.actions]),
  output: Action.of([Saved]),
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
  initialState: () => ({ draft: "", save: Task.idle }),
  reducer: {
    // The cache filled or refetched: adopt the server text as the draft.
    HookChanged: ({ previous }, { state, hooks }) =>
      hooks.text !== undefined && hooks.text !== previous.text
        ? { ...state, draft: hooks.text }
        : state,
    Typed: ({ text }, { state }) => ({ ...state, draft: text }),
    Submitted: (_payload, { state, props }) =>
      Task.start(state, "save", save.run({ id: props.noteId, text: state.draft })),
    SaveResolved: ({ value }, { state, props }) => [
      { ...state, draft: value, save: Task.resolved(value) },
      Command.output(Saved, { id: props.noteId }),
    ],
    SaveRejected: ({ error }, { state }) => ({ ...state, save: Task.rejected(error) }),
  },
  render: ({ state, hooks, dispatch }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        dispatch(Submitted.make({}));
      }}
    >
      {hooks.status === "pending" && <p>Loading</p>}
      {hooks.status === "error" && <p>Could not load the note</p>}
      <textarea
        value={state.draft}
        disabled={hooks.status !== "success"}
        onChange={(event) => dispatch(Typed.make({ text: event.target.value }))}
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
