---
title: Install devtools
description: Merge a devtools sink into the root layer, tune the console logger, or forward events elsewhere.
order: 5
example: devtools-console
---

# Install devtools

Devtools are a service. Merge a sink into the root layer and every feature under that runtime reports its transitions, commands, outputs and defects.

## Install the console sink

`consoleDevtoolsLayer()` is `Layer<never>`, so both branches of a `DEV` ternary have one type and the root layer's own requirements do not move.

```tsx
import { consoleDevtoolsLayer, createRuntime } from "@wych/react";
import { Context, Effect, Layer } from "effect";

class Api extends Context.Service<Api, { readonly load: Effect.Effect<string> }>()("Api") {}

const app = Layer.succeed(Api)({ load: Effect.succeed("ok") });

const devtools = import.meta.env.DEV ? consoleDevtoolsLayer() : Layer.empty;

const { component } = createRuntime(Layer.mergeAll(app, devtools));
```

Name your components. The name is in every event, and `component(feature)` with no name reports `"TeaFeature"`.

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
- `timestamps` (default `true`): wall-clock stamp and elapsed since the last event.
- `colors`: CSS for the `%c` directives, each field optional.
- `console` (default `globalThis.console`): the four methods the logger calls.

`consoleDevtoolsLayer(options)` is the same pair in one call.

## Swap the predicate

The default drops `PropsChanged` and `HookChanged` transitions where `previous === next`. `skipUnchanged` drops any transition that did not move state.

```tsx continue
import { skipUnchanged } from "@wych/react";

const quiet = devtoolsLayer(createConsoleDevtools({ predicate: skipUnchanged }));

const onlyCart = devtoolsLayer(
  createConsoleDevtools({ predicate: (event) => event.name === "Cart" }),
);
```

`skipUnchanged` also eats two events worth seeing: `Unmounted`, whose returned state is discarded by design, and a dispatch that deliberately no-ops.

## Forward events somewhere else

A sink is one synchronous method. Every field of an event is encodable, so a `postMessage` transport needs no serialiser.

```tsx continue
import type { DevtoolsEvent } from "@wych/react";

const bridge = devtoolsLayer({
  onEvent: (event: DevtoolsEvent) => {
    window.postMessage({ source: "wych", event }, "*");
  },
});

const { component: instrumented } = createRuntime(Layer.mergeAll(app, bridge));
```

`onEvent` is called at the emission point, so a slow sink slows the fold. Buffer inside your sink if the transport is expensive.

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
