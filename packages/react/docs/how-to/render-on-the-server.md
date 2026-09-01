---
title: Render on the server
description: Paint the initial state with renderToString, then hydrate the same feature on the client.
order: 4
---

# Render on the server

`renderToString` paints a feature's initial state. Props are validated, `useFeature` fragments resolve, and nothing folds: lifecycle actions and commands live in effects, which the server never runs.

## Render to HTML

```tsx
import { Action, Command, createRuntime, define } from "@wych/react";
import { Effect, Layer, Schema } from "effect";
import { renderToString } from "react-dom/server";

let folds = 0;
let commandsRun = 0;

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

const Counter = component(counter, { name: "Counter" });

const Total = () => {
  const { state, props } = Counter.useFeature();
  return <span>{`${props.start}:${state.count}`}</span>;
};

const html = renderToString(<Counter start={5} />);

console.log(html.includes(">5</span>") && html.includes("5:5"));
// => true
```

`initialState(props)` produced `{ count: 5 }`, and the `Total` fragment read the same snapshot through `Counter.useFeature()`. A fragment resolves its provider on the server because the provider is part of the render.

## Nothing folds

```tsx continue
console.log([folds, commandsRun]);
// => [0, 0]
```

`Mounted` is dispatched from an effect after commit, and commands are forked by the runtime. The server runs neither. A feature whose first paint depends on `Mounted` renders its initial state on the server and its folded state after hydration, which React reports as a mismatch.

Put anything the server must paint in `initialState`.

## Props are still validated

Validation runs in the render path, so a malformed prop throws on the server too.

```tsx continue
const bad = { start: "not a number" } as unknown as { readonly start: number };

renderToString(<Counter {...bad} />);
// throws TypeError: Invalid props for <Counter>
```

The throw reaches the nearest error boundary, or the caller of `renderToString` when there is none.

## Hydrate on the client

Hydration mounts the same feature over the server markup. `Mounted` fires once after commit, and the command it returned runs then.

```tsx continue
import { hydrateRoot } from "react-dom/client";

const root = document.getElementById("root")!;
root.innerHTML = html; // what the server sent
hydrateRoot(root, <Counter start={5} />);

await new Promise((resolve) => setTimeout(resolve, 50)); // let the mount effect run
console.log([folds, commandsRun]);
// => [1, 1]
```

Pass the props the server used. They feed `initialState`, so a different value paints different HTML and breaks hydration.

## Wrap the tree in Provider

`Provider` is optional: a component resolves the runtime it was created from without one. Use it to share one runtime with plain React components that call `useRuntime`.

```tsx continue
const page = renderToString(
  <Provider>
    <Counter start={7} />
  </Provider>,
);

console.log(page.includes(">7</span>") && page.includes("7:7"));
// => true
```

`Provider` changes nothing about what folds. The server behaviour above holds with or without it. See the [runtime reference](/docs/reference/runtime) for `useRuntime` and the props contract.
