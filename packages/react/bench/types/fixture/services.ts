// Service signatures only: the type workload is what the bench measures.
import { Context, Effect, Schema } from "effect";
import type { Appearance, Mode, Todo, TodoFilter, TodoPage } from "./schemas";

export class TodoApiError extends Schema.TaggedError<TodoApiError>()("TodoApiError", {
  cause: Schema.Defect(),
}) {}

export class TodoApi extends Context.Service<
  TodoApi,
  {
    readonly search: (
      filter: TodoFilter,
    ) => Effect.Effect<TodoPage, TodoApiError | Schema.SchemaError>;
    readonly save: (todo: Todo) => Effect.Effect<Todo, TodoApiError>;
    readonly archive: (ids: ReadonlyArray<string>) => Effect.Effect<void, TodoApiError>;
  }
>()("TodoApi") {}

export class AttachmentStore extends Context.Service<
  AttachmentStore,
  { readonly recent: Effect.Effect<ReadonlyArray<unknown>> }
>()("AttachmentStore") {}

export class AppearanceError extends Schema.TaggedError<AppearanceError>()("AppearanceError", {
  cause: Schema.Defect(),
}) {}

export class AppearanceApi extends Context.Service<
  AppearanceApi,
  {
    readonly derive: (
      cover: URL,
      options: { readonly mode: Mode; readonly contrast?: number },
    ) => Effect.Effect<Appearance, Schema.SchemaError | AppearanceError>;
    readonly publish: (appearance: Appearance) => Effect.Effect<void, AppearanceError>;
    readonly uploadCover: (cover: URL) => Effect.Effect<void, AppearanceError>;
    readonly activate: (name: string) => Effect.Effect<void, AppearanceError>;
  }
>()("AppearanceApi") {}
