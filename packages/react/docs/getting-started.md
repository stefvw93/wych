---
title: Getting started
description: Declare a feature, build it, and render it as a React component.
order: 2
---

# Getting started

## 1. Create a runtime

`createRuntime` takes one argument — the root `Layer` that satisfies the
services your commands request.

```ts
import { Layer } from "effect";
import { createRuntime } from "@wych/react";

export const { component } = createRuntime(Layer.empty);
```

## 2. Declare the feature

`define` describes the shapes. Props and state are `Schema.Struct`s; actions and
outputs are tagged vocabularies built with `Action.of`.

```ts
import { Schema } from "effect";
import { Action, define } from "@wych/react";

const Reached = Action.output("Reached", { at: Schema.Number });

const Counter = define({
  props: Schema.Struct({ step: Schema.Number, label: Schema.String }),
  state: Schema.Struct({ count: Schema.Number }),
  action: Action.of([Action("Bumped", {})]),
  output: Action.of([Reached]),
});
```

Actions are _internal_ — they reach the reducer. Outputs are _outbound_ — they
leave through an `on<Tag>` prop and never re-enter the reducer. The two channels
are not assignable to each other in either direction.

## 3. Build it

`create` supplies the behaviour: an initial state, a reducer keyed by tag, and a
render function.

```ts
import { Command } from "@wych/react";

const counter = Counter.create({
  initialState: (props) => ({ count: props.step }),
  reducer: {
    Bumped: (_action, { state, props }) => {
      const count = state.count + props.step;
      return count >= 10
        ? [{ ...state, count }, Command.output(Reached, { at: count })]
        : { ...state, count };
    },
  },
  render: ({ state, props, dispatch }) => (
    <div>
      <span>{props.label}</span>
      <span>{state.count}</span>
      <button onClick={() => dispatch({ _tag: "Bumped" })}>bump</button>
    </div>
  ),
});
```

A handler receives the action's **payload** — `_tag` is stripped, because the
handler key already named the tag. It returns either a bare state or a
`[state, command]` tuple.

## 4. Render it

```tsx
const CounterView = component(counter, { name: "Counter" });

<CounterView step={2} label="Clicks" onReached={({ at }) => console.log(at)} />;
```

Props are validated against the schema with `onExcessProperty: "error"`, on
mount and whenever props identity changes. A malformed prop **throws** — it is
the parent's defect, so it belongs at an error boundary, not in this feature's
`Error` handler.
