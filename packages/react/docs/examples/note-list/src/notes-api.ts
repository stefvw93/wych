import { Context, Effect, Layer, Schema } from "effect";

export const Note = Schema.Struct({ id: Schema.String, text: Schema.String });

export class NotesApi extends Context.Service<
  NotesApi,
  {
    readonly list: Effect.Effect<ReadonlyArray<typeof Note.Type>, Error>;
    readonly save: (note: {
      readonly id: string;
      readonly text: string;
    }) => Effect.Effect<string, Error>;
  }
>()("NotesApi") {}

export const notesApiLayer = Layer.succeed(NotesApi)({
  list: Effect.succeed([{ id: "n1", text: "Buy milk" }]),
  save: (note) => Effect.succeed(`${note.id}@${Date.now()}`),
});
