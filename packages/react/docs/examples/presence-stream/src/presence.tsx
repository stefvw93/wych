import { Action, Subscription, define } from "@wych/react";
import { Effect, Schema, Stream } from "effect";
import { PresenceApi } from "./presence-api";

const Changed = Action("Changed", { userId: Schema.String, online: Schema.Boolean });

const Presence = define({
  props: Schema.Struct({ roomId: Schema.String }),
  state: Schema.Struct({ online: Schema.Array(Schema.String) }),
  action: Action.of([Changed]),
});

export const presence = Presence.create({
  initialState: () => ({ online: [] }),
  reducer: {
    Changed: ({ userId, online }, { state }) => ({
      ...state,
      online: online ? [...state.online, userId] : state.online.filter((id) => id !== userId),
    }),
    PropsChanged: ({ previous }, { state, props }) =>
      previous.roomId === props.roomId ? state : { ...state, online: [] },
  },
  subscriptions: ({ props }) => ({
    [`presence:${props.roomId}`]: Subscription.effect((dispatch) =>
      Effect.gen(function* () {
        const api = yield* PresenceApi;
        yield* Stream.runForEach(api.events(props.roomId), (event) =>
          dispatch(Changed.make(event)),
        );
      }),
    ),
  }),
  render: ({ state }) => (
    <ul>
      {state.online.map((userId) => (
        <li key={userId}>{userId}</li>
      ))}
    </ul>
  ),
});
