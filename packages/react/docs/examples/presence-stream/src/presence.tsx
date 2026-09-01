import { Action, Command, define } from "@wych/react";
import { Effect, Schema, Stream } from "effect";
import { PresenceApi } from "./presence-api";

const Changed = Action("Changed", { userId: Schema.String, online: Schema.Boolean });

const Presence = define({
  props: Schema.Struct({ roomId: Schema.String }),
  state: Schema.Struct({ online: Schema.Array(Schema.String) }),
  action: Action.of([Changed]),
});

const subscribe = (roomId: string) =>
  Command.keyed(
    "presence",
    Command.effect<typeof Changed.Type, PresenceApi>((dispatch) =>
      Effect.flatMap(PresenceApi, (api) =>
        Stream.runForEach(api.events(roomId), (event) => dispatch(Changed.make(event))),
      ),
    ),
  );

export const presence = Presence.create({
  initialState: () => ({ online: [] }),
  reducer: {
    Changed: ({ userId, online }, { state }) => ({
      ...state,
      online: online ? [...state.online, userId] : state.online.filter((id) => id !== userId),
    }),
    Mounted: (_payload, { state, props }) => [state, subscribe(props.roomId)],
    PropsChanged: ({ previous }, { state, props }) =>
      previous.roomId === props.roomId
        ? state
        : [{ ...state, online: [] }, Command.restart("presence", subscribe(props.roomId))],
    Unmounted: (_payload, { state }) => [state, Command.cancel("presence")],
  },
  render: ({ state }) => (
    <ul>
      {state.online.map((userId) => (
        <li key={userId}>{userId}</li>
      ))}
    </ul>
  ),
});
