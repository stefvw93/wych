---
title: Render on the server
description: Paint the initial state with renderToString, then hydrate the same feature on the client.
order: 4
example: ssr-hydrate
---

# Render on the server

A component whose state lives in `useEffect` paints empty on the server, then fills in after hydration. The server render was wasted, and any state the effect derived from `window` or `Date.now()` is a hydration mismatch waiting to happen.

`renderToString` paints a feature's initial state. Props are validated, `useFeature` fragments resolve, and nothing folds: lifecycle actions and commands live in effects, which the server never runs. Put what the server must paint in `initialState`, and keep it a pure function of the props.

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
        Command.effect((dispatch) =>
          Effect.gen(function* () {
            commandsRun += 1;
            yield* dispatch(Bumped.make({}));
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

The two counters are the page's instrument: `folds` counts `Mounted` handler calls, `commandsRun` counts its command. The command bumps once, so a mounted counter shows one more than its `start`.

## Nothing folds

```tsx continue
console.log([folds, commandsRun]);
// => [0, 0]
```

`Mounted` is dispatched from an effect after commit, and commands are forked by the runtime. The server runs neither, so the HTML shows `5`, and `Mounted`'s bump is absent from it.

## Props are still validated

Validation runs in the render path, so a malformed prop throws on the server too.

```tsx continue
const bad = { start: "not a number" } as unknown as { readonly start: number };

renderToString(<Counter {...bad} />);
// throws TypeError: Invalid props for <Counter>
```

The throw reaches the nearest error boundary, or the caller of `renderToString` when there is none.

## Hydrate on the client

Hydration mounts the same feature over the server markup. The client's first render paints `initialState(props)` again, which matches the HTML. `Mounted` fires once after commit, and the command it returned runs then.

```tsx continue
import { hydrateRoot } from "react-dom/client";

const errors: string[] = [];
const root = document.getElementById("root")!;
root.innerHTML = html; // what the server sent
hydrateRoot(root, <Counter start={5} />, {
  onRecoverableError: (error) => errors.push(String(error)),
});

await new Promise((resolve) => setTimeout(resolve, 50)); // let the mount effect run
console.log([folds, commandsRun]);
// => [1, 1]
console.log(root.querySelector("span")?.textContent);
// => "6"
console.log(errors);
// => []
```

The bump landed after hydration, so the reader saw `5` become `6` and React reported nothing. A feature whose first paint depends on `Mounted` behaves the same way: the server paints the initial state, hydration accepts it, then the folded state repaints. The cost is that repaint, so put what the server must paint in `initialState`.

`onRecoverableError` is where React reports a hydration problem. Without it React calls `reportError`, and the message lands in the browser console as an uncaught error.

## The hydration mismatch

Pass the props the server used. They feed `initialState`, so a different value paints different HTML, and React discards the server markup.

```tsx continue
const mismatched = document.createElement("div");
document.body.appendChild(mismatched);
mismatched.innerHTML = html; // painted from start={5}
hydrateRoot(mismatched, <Counter start={6} />, {
  onRecoverableError: (error) => errors.push(String(error)),
});

await new Promise((resolve) => setTimeout(resolve, 50));
console.log(errors.map((message) => message.split(".")[0]));
// => ["Error: Hydration failed because the server rendered text didn't match the client"]
console.log(mismatched.querySelector("span")?.textContent);
// => "7"
```

The full message continues: "As a result this tree will be regenerated on the client." React throws the server markup away and renders the tree from scratch. The feature mounts as if there had been no server paint. The page still works. The server render was wasted, and in development the message lists the usual causes.

In a feature the cause is one of two things: the client passed different props than the server, or `initialState` read something the server did not have, such as `Date.now()`, `localStorage` or `window`. Both make the client's first render disagree with the HTML. Move that read into a `Mounted` command, and paint a value the server can compute.

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
