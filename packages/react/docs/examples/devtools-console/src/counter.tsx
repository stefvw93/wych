import { Action, define } from "@wych/react";
import { Schema } from "effect";
import { component } from "./runtime";

const Bumped = Action("Bumped");

const counter = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ count: Schema.Number }),
  actions: [Bumped],
}).create({
  initialState: () => ({ count: 0 }),
  reducer: { Bumped: (_payload, { state }) => ({ count: state.count + 1 }) },
  render: ({ state, dispatch }) => <button onClick={() => dispatch(Bumped)}>{state.count}</button>,
});

export const Counter = component(counter, { name: "Counter" });
