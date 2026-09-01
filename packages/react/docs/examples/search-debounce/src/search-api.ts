import { Context, Effect, Schema } from "effect";

export const Hits = Schema.Array(Schema.String);

export class SearchApi extends Context.Service<
  SearchApi,
  { readonly hits: (query: string) => Effect.Effect<ReadonlyArray<string>> }
>()("SearchApi") {}
