import { Layer, Schema } from "effect";
import { Action, Command, createRuntime, define } from "@wych/react";

const Bumped = Action("Bumped", {});
const Reached = Action.output("Reached", { at: Schema.Number });

export const counter = define({
  props: Schema.Struct({ step: Schema.Number }),
  state: Schema.Struct({ count: Schema.Number }),
  action: Action.of([Bumped]),
  output: Action.of([Reached]),
}).create({
  initialState: (props) => ({ count: props.step }),
  reducer: {
    Bumped: (_payload, { state, props }) => {
      const count = state.count + props.step;
      return count >= 10 ? [{ count }, Command.output(Reached, { at: count })] : { count };
    },
  },
  render: ({ state, dispatch }) => (
    <button onClick={() => dispatch(Bumped.make({}))}>{state.count}</button>
  ),
});

const { component } = createRuntime(Layer.empty);
export const Counter = component(counter, { name: "Counter" });

export { Bumped };
