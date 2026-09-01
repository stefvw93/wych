import { Context, Stream } from "effect";

export class PresenceApi extends Context.Service<
  PresenceApi,
  {
    readonly events: (
      roomId: string,
    ) => Stream.Stream<{ readonly userId: string; readonly online: boolean }>;
  }
>()("PresenceApi") {}
