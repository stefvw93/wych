---
title: Install devtools
description: Merge a console sink into the root layer, tune what it prints, or forward events to a sink of your own.
order: 5
example: devtools-console
---

# Install devtools

A feature moved to a state you did not expect. In a `useReducer` app the way to see the action and the state on both sides is a `console.log` inside the reducer, which you then remove before shipping. Devtools are a service. Merge a sink into the root layer and every feature under that runtime reports its transitions, commands, outputs and defects, with no change to any reducer.

## Install the console sink

```tsx
import { consoleDevtoolsLayer, createRuntime } from "@wych/react";
import { Context, Effect, Layer } from "effect";

class Api extends Context.Service<Api, { readonly load: Effect.Effect<string> }>()("Api") {}

const app = Layer.succeed(Api)({ load: Effect.succeed("ok") });

const devtools = import.meta.env.DEV ? consoleDevtoolsLayer() : Layer.empty;

const { component } = createRuntime(Layer.mergeAll(app, devtools));
```

`consoleDevtoolsLayer()` is `Layer<never>`, so both branches of the `DEV` ternary have one type and the root layer's own requirements do not move. The one decision here is the condition: `import.meta.env.DEV` keeps the sink out of the production bundle's layer, and a flag of your own works the same way.

Name your components. The name is in every event, and `component(feature)` with no name reports `"WychFeature"`.

```tsx continue
import { Action, define } from "@wych/react";
import { Schema } from "effect";

const Bumped = Action("Bumped", {});

const counter = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ count: Schema.Number }),
  action: Action.of([Bumped]),
}).create({
  initialState: () => ({ count: 0 }),
  reducer: { Bumped: (_payload, { state }) => ({ count: state.count + 1 }) },
  render: ({ state, dispatch }) => (
    <button onClick={() => dispatch(Bumped.make({}))}>{state.count}</button>
  ),
});

const Counter = component(counter, { name: "Counter" });
```

## Set the console options

`createConsoleDevtools` takes the options; `devtoolsLayer` installs the sink it returns.

```tsx continue
import { createConsoleDevtools, devtoolsLayer } from "@wych/react";

const verbose = devtoolsLayer(
  createConsoleDevtools({
    collapsed: false,
    diff: true,
    timestamps: false,
  }),
);
```

- `collapsed` (default `true`): use `groupCollapsed` for each event group.
- `predicate` (default `skipUnchangedAmbient`): keep the event?
- `diff` (default `false`): print a shallow own-keys diff of the two states.
- `timestamps` (default `true`): a wall-clock stamp, and the time since that mount's last event.
- `colors`: CSS for the `%c` directives (`previous`, `action`, `next`, `command`, `output`, `defect`), each optional.
- `console` (default `globalThis.console`): the five methods the logger calls: `group`, `groupCollapsed`, `groupEnd`, `log`, `error`.

`consoleDevtoolsLayer(options)` is the same pair in one call.

`diff` is shallow on purpose. A change inside a nested object shows as one changed key, and the two full states are printed either way. Turn it on when a state has many keys and you want to see which one moved.

## Swap the predicate

The default drops `PropsChanged` and `HookChanged` transitions where `previous === next`. `skipUnchanged` drops any transition that did not move state.

```tsx continue
import { skipUnchanged } from "@wych/react";

const quiet = devtoolsLayer(createConsoleDevtools({ predicate: skipUnchanged }));

const onlyCounter = devtoolsLayer(
  createConsoleDevtools({ predicate: (event) => event.name === "Counter" }),
);
```

Pick `skipUnchanged` when a reducer no-ops on most actions and the log is all noise. It also eats two events worth seeing: `Unmounted`, whose returned state is discarded by design, and a dispatch that deliberately no-ops. Keep the default when one of those is what you opened the console for.

A predicate that throws does not take the sink down: the event is kept and the throw is reported through `console.error`.

## Forward events somewhere else

A sink is one synchronous method. Every field of an event is encodable, so a `postMessage` transport needs no serialiser.

```tsx continue
import type { DevtoolsEvent } from "@wych/react";

const bridge = devtoolsLayer({
  onEvent: (event: DevtoolsEvent) => {
    window.postMessage({ source: "wych", event }, "*");
  },
});
```

`bridge` goes into `Layer.mergeAll` in place of `devtools`, and the features do not change.

`onEvent` is called at the emission point, so a slow sink slows the fold. Buffer inside your sink if the transport is expensive. A sink that throws is disabled for the rest of that mount and never called again from it, so catch inside `onEvent` if the transport can fail.

## What one event looks like

A `Transition` for a dispatched `Bumped`, as JSON:

```json
{
  "_tag": "Transition",
  "name": "Counter",
  "instance": "3",
  "cause": { "_tag": "Dispatch" },
  "action": { "_tag": "Bumped" },
  "previous": { "count": 0 },
  "next": { "count": 1 }
}
```

`previous` and `next` are the real state references. A sink that keeps them past the call copies them itself.

There is no timestamp on the event. The sink is called synchronously, so a receiver that wants a clock reads its own. The four event shapes and every `cause` are in the [devtools reference](/docs/reference/devtools).
