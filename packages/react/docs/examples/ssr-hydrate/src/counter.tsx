import { Action, Command, createRuntime, define } from "@wych/react";
import { Effect, Layer, Schema } from "effect";

let folds = 0;
let commandsRun = 0;

/** How many times `Mounted` folded and how many commands ran. */
export const counts = () => [folds, commandsRun] as const;

const Bumped = Action("Bumped", {});

const counter = define({
  props: Schema.Struct({ start: Schema.Number }),
  state: Schema.Struct({ count: Schema.Number }),
  action: Action.of([Bumped]),
}).create({
  initialState: (props) => ({ count: props.start }),
  reducer: {
    Bumped: (_payload, { state }) => ({ count: state.count + 1 }),
    Mounted: (_payload, { state }) => {
      folds += 1;
      return [
        state,
        Command.effect(() =>
          Effect.sync(() => {
            commandsRun += 1;
          }),
        ),
      ];
    },
  },
  render: ({ state, dispatch }) => (
    <div>
      <span>{state.count}</span>
      <button onClick={() => dispatch(Bumped.make({}))}>bump</button>
      <Total />
    </div>
  ),
});

const { component, Provider } = createRuntime(Layer.empty);

export const Counter = component(counter, { name: "Counter" });

const Total = () => {
  const { state, props } = Counter.useFeature();
  return <span>{`${props.start}:${state.count}`}</span>;
};

export { Provider };
