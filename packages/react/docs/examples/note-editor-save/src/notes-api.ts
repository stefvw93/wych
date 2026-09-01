import { Context, Effect, Layer } from "effect";

export class NotesApi extends Context.Service<
  NotesApi,
  {
    readonly save: (note: {
      readonly id: string;
      readonly text: string;
    }) => Effect.Effect<string, Error>;
  }
>()("NotesApi") {}

export const notesApiLayer = Layer.succeed(NotesApi)({
  save: (note) => Effect.succeed(`${note.id}@${Date.now()}`),
});
