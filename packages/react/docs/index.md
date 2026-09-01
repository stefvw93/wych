---
title: Overview
description: A TEA-style feature runtime for React, built on Effect.
order: 0
---

# @wych/react

A feature is schema-typed props and state, a tagged action vocabulary, an
optional output vocabulary, and a pure reducer. The reducer returns the next
state and, optionally, a `Command` that describes work. The runtime interprets
commands as Effects and renders the feature as a React component.

```tsx
import { Effect, Layer, Schema } from "effect";
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

// <Counter step={5} onReached={({ at }) => console.log(at)} />

const result = await Effect.runPromise(
  counter.run([Bumped.make({}), Bumped.make({})], {
    props: { step: 5 },
    hooks: {},
    layer: Layer.empty,
  }),
);
console.log(result.state);
// => { count: 15 }
console.log(result.outputs);
// => [{ _tag: "Reached", at: 10 }, { _tag: "Reached", at: 15 }]
```

Three consumers share one core and one command interpreter:

- `feature.reduce(action, snapshot)`: the reducer as one pure function.
- `feature.run(actions, options)`: folds a sequence to quiescence and reports
  what was emitted.
- `component(feature)`: the React binding.

## Install

```sh
npm install @wych/react effect react react-dom
```

`effect` (v4), `react` and `react-dom` are peer dependencies.

## Tutorial

One app, three chapters. Start here.

- [Your first feature](/docs/tutorial/your-first-feature): build a `NoteEditor`, mount it, fold one action without React.
- [Async work](/docs/tutorial/async-work): save through an Effect service with `Task`.
- [Composing features](/docs/tutorial/composing-features): a `NoteList` parent, outputs, `Children`, `useFeature`.

## How-to

- [Debounce and take latest](/docs/how-to/debounce-and-take-latest): wait for a pause, then interrupt the request in flight.
- [Subscribe to a stream](/docs/how-to/subscribe-to-a-stream): start a source on `Mounted`, cancel it on `Unmounted`.
- [Test a feature without React](/docs/how-to/test-a-feature-without-react): `reduce`, `run`, a test layer, the recorder.
- [Render on the server](/docs/how-to/render-on-the-server): `renderToString`, then hydrate.
- [Install devtools](/docs/how-to/install-devtools): the console logger, its options, a custom sink.
- [Use with AI agents](/docs/how-to/use-with-ai-agents): the docs ship in the package and at `/llms.txt`.

## Reference

- [Runtime](/docs/reference/runtime): `createRuntime`, `component`, `useFeature`, output props, props validation.
- [Features](/docs/reference/features): `define`, `create`, `reduce`, `run`, `Next`, `Children`.
- [Actions and outputs](/docs/reference/actions): `Action`, `Action.output`, `Action.of`, channels.
- [Commands](/docs/reference/commands): every constructor, groups, the contextual typing rule.
- [Lifecycle](/docs/reference/lifecycle): the five runtime actions and change detection.
- [Tasks](/docs/reference/tasks): `Task`, `TaskValue`, the matcher and guards.
- [Devtools](/docs/reference/devtools): the service, sinks, the event union, the recorder.

## Explanation

- [The model](/docs/explanation/the-model): TEA on React, and why three consumers share one interpreter.
- [Actions and outputs](/docs/explanation/actions-and-outputs): why the outbound channel never reaches the reducer.
- [Commands as data](/docs/explanation/commands-as-data): why the reducer describes work and the runtime runs it.
- [Groups and cancellation](/docs/explanation/groups-and-cancellation): one flat namespace, `key ?? tag`, `restart` as sugar.
- [Children and opaque props](/docs/explanation/children-and-opaque-props): why a React node cannot be a schema value.
