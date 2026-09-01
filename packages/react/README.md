# @wych/react

A TEA-style feature runtime for React, built on [Effect](https://effect.website).

A feature is schema-typed props and state, a tagged action vocabulary, an
optional output vocabulary, and a pure reducer. The reducer returns the next
state and, optionally, a `Command` that describes work. The runtime interprets
commands as Effects and renders the feature as a React component.

## Install

```sh
npm install @wych/react effect react react-dom
```

`effect` (v4), `react` and `react-dom` are peer dependencies.

## A feature

```tsx
import { Layer, Schema } from "effect";
import { Action, Command, createRuntime, define } from "@wych/react";

const Bumped = Action("Bumped", {});
const Reached = Action.output("Reached", { at: Schema.Number });

const counter = define({
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
```

```tsx
<Counter step={5} onReached={({ at }) => console.log(at)} />
```

The same feature folds without React: `counter.reduce(action, snapshot)` is
the reducer as one pure function, and `counter.run(actions, options)` folds a
sequence to quiescence and reports what was emitted.

## Docs

The docs ship inside this package at `node_modules/@wych/react/docs`, and at
[wych.dev/docs](https://wych.dev/docs).

- `docs/tutorial/`: one app in three chapters.
- `docs/how-to/`: recipes for a competent reader.
- `docs/reference/`: every export and its contract.
- `docs/explanation/`: why the model is shaped this way.

Start with `docs/index.md`.

## License

MIT
