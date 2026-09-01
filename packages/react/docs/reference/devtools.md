---
title: Devtools
description: The Devtools service, sinks, the event union, the console logger and the recorder.
order: 7
---

# Devtools

Devtools are a service. The runtime resolves a `DevtoolsSink` from the root
layer and reports every transition, command, output and defect to it. With no
sink installed the runtime allocates nothing at those sites.

Every snippet on this page builds on one feature: a counter that saves through
a command and announces when it passes a threshold.

```tsx
import { Effect, Layer, Schema } from "effect";
import {
  Action,
  Command,
  consoleDevtoolsLayer,
  createConsoleDevtools,
  createRecorder,
  createRuntime,
  define,
  devtoolsLayer,
  skipUnchanged,
  skipUnchangedAmbient,
} from "@wych/react";
import type {
  CommandSummary,
  DefectSummary,
  DevtoolsCause,
  DevtoolsCommand,
  DevtoolsDefect,
  DevtoolsEvent,
  DevtoolsOutput,
  DevtoolsSink,
  DevtoolsTransition,
} from "@wych/react";

const Bumped = Action("Bumped", {});
const Reached = Action.output("Reached", { at: Schema.Number });

const Counter = define({
  props: Schema.Struct({ step: Schema.Number }),
  state: Schema.Struct({ count: Schema.Number }),
  action: Action.of([Bumped]),
  output: Action.of([Reached]),
});

export const counter = Counter.create({
  initialState: Counter.initialState(() => ({ count: 0 })),
  reducer: Counter.reducer({
    Bumped: (_payload, { state, props }) => [
      { count: state.count + props.step },
      (next) => Command.output(Reached, { at: next.count }),
    ],
  }),
  render: Counter.render(({ state }) => <b>{state.count}</b>),
});
```

## `Devtools`

```ts fragment
Devtools: Context.Reference<DevtoolsSink>; // default: noopDevtools
```

A `Context.Reference`, so reading it is total and installing one widens no
service requirement. Adding devtools moves nothing about `RootR` and touches no
`component` call.

## `DevtoolsSink`

```ts fragment
interface DevtoolsSink {
  readonly onEvent: (event: DevtoolsEvent) => void;
}
```

One method, called synchronously at the emission point. A sink that throws is
disabled for the rest of the mount.

```ts continue
const tags: Array<string> = [];

const sink: DevtoolsSink = {
  onEvent: (event) => {
    tags.push(event._tag);
  },
};
```

## `noopDevtools`

```ts fragment
noopDevtools: DevtoolsSink;
```

The default value of the reference, and the signal that nobody installed a
sink. The runtime compares the resolved reference against this exact frozen
object by identity.

## `devtoolsLayer`

```ts fragment
devtoolsLayer(sink: DevtoolsSink): Layer.Layer<never>
```

`Layer<never>` with no error channel, so merging it changes no type.

```ts continue
const AppLayer = Layer.empty;

const { component } = createRuntime(
  Layer.mergeAll(AppLayer, import.meta.env.DEV ? devtoolsLayer(sink) : Layer.empty),
);

const CounterView = component(counter, { name: "Counter" });
```

## `consoleDevtoolsLayer` and `createConsoleDevtools`

```ts fragment
consoleDevtoolsLayer(options?: ConsoleDevtoolsOptions): Layer.Layer<never>
createConsoleDevtools(options?: ConsoleDevtoolsOptions): DevtoolsSink
```

`consoleDevtoolsLayer(options)` is `devtoolsLayer(createConsoleDevtools(options))`.
The logger prints one console group per event: previous state, action, next
state and cause.

```ts continue
const devRuntime = createRuntime(
  Layer.mergeAll(AppLayer, import.meta.env.DEV ? consoleDevtoolsLayer() : Layer.empty),
);
```

Every option has a default.

```ts continue
const verbose = createConsoleDevtools({
  collapsed: false, // default true. false uses console.group
  predicate: skipUnchanged, // default skipUnchangedAmbient
  diff: true, // default false: shallow own-keys diff of the two states
  timestamps: false, // default true: wall clock plus elapsed since the last event
  colors: { action: "color: #03A9F4; font-weight: bold" },
  console: globalThis.console, // default globalThis.console
});
```

`diff` is shallow and reads own keys only. `colors` fields are CSS strings for
the `%c` directives, all individually overridable: `previous`, `action`,
`next`, `command`, `output` and `defect`. `console` takes any object with
`group`, `groupCollapsed`, `groupEnd`, `log` and `error`.

## Predicates

```ts fragment
skipUnchangedAmbient(event: DevtoolsEvent): boolean
skipUnchanged(event: DevtoolsEvent): boolean
```

`skipUnchangedAmbient` is the console default. It drops a `PropsChanged` or
`HookChanged` transition where `previous === next`, and keeps everything else.

`skipUnchanged` drops any transition where state did not move. It also eats two
cases the default keeps: `Unmounted`, whose returned state is discarded by
design, and a dispatch that deliberately no-ops.

```ts continue
const unchanged = { count: 1 };

const unchangedProps: DevtoolsTransition = {
  _tag: "Transition",
  name: "Counter",
  instance: "1",
  cause: { _tag: "Lifecycle" },
  action: { _tag: "PropsChanged" },
  previous: unchanged,
  next: unchanged,
};

console.log(skipUnchangedAmbient(unchangedProps));
// => false
console.log(skipUnchanged(unchangedProps));
// => false

const noopDispatch: DevtoolsTransition = { ...unchangedProps, action: { _tag: "Bumped" } };

console.log(skipUnchangedAmbient(noopDispatch));
// => true
console.log(skipUnchanged(noopDispatch));
// => false
```

## `createRecorder`

```ts fragment
createRecorder(): { readonly sink: DevtoolsSink; readonly events: ReadonlyArray<DevtoolsEvent>; readonly clear: () => void }
```

An in-memory sink, for asserting on the event stream in a test. `events` is the
live array as it grows. Emission is synchronous, so by the time an effect
resolves everything has been recorded. The recorder is not itself a sink;
install `recorder.sink` through `devtoolsLayer`.

```ts continue
const recorder = createRecorder();

const observed = createRuntime(Layer.mergeAll(AppLayer, devtoolsLayer(recorder.sink)));
const ObservedCounter = observed.component(counter, { name: "Counter" });

recorder.clear();
console.log(recorder.events.length);
// => 0
```

Events come from a mounted component. Emission lives in the store that
`component` builds, so `feature.run` reports nothing: a recorder layer passed to
`run` records an empty array. See
[Install devtools](/docs/how-to/install-devtools).

## `DevtoolsEvent`

```ts fragment
type DevtoolsEvent = DevtoolsTransition | DevtoolsCommand | DevtoolsOutput | DevtoolsDefect;
```

Every event carries `name`, `instance` and `cause`. `name` comes from
`component(feature, { name })` and is `"TeaFeature"` when unnamed. `instance`
is unique per mount and per page, and it is not gapless: StrictMode
double-invokes the store initialiser and burns an id.

There is no timestamp. The sink is called synchronously at the emission point,
so a receiver that wants a clock has one.

Every field is encodable, so a sink can be a `postMessage` transport or a
replay log.

### `DevtoolsTransition`

A reducer ran, whether or not state moved. `previous` and `next` are the real
state references, so a sink that keeps them past the call has to copy them.

```ts continue
const transition: DevtoolsTransition = {
  _tag: "Transition",
  name: "Counter",
  instance: "1",
  cause: { _tag: "Dispatch" },
  action: { _tag: "Bumped" },
  previous: { count: 0 },
  next: { count: 2 },
};
```

### `DevtoolsCommand`

A reducer returned a command and the runtime took delivery of it.

```ts continue
const issued: DevtoolsCommand = {
  _tag: "Command",
  name: "Counter",
  instance: "1",
  cause: { _tag: "Dispatch" },
  group: "Bumped",
  command: { _tag: "Effect" },
  dropped: false,
};
```

`group` is the default address of this work: the issuing action's tag, where
unkeyed leaves book. A `Batch` can book members under several names, and those
names are on the `Keyed` nodes inside `command`.

`dropped: true` means nothing was there to take the work, which happens for a
command dispatched after unmount. `false` means the work reached a live mount,
not that it ran to completion.

### `DevtoolsOutput`

An outbound message left the feature. It carries the whole message including
`_tag`, unlike the `on<Tag>` prop the parent receives.

```ts continue
const announced: DevtoolsOutput = {
  _tag: "Output",
  name: "Counter",
  instance: "1",
  cause: { _tag: "Command", action: "Bumped" },
  output: Reached.make({ at: 2 }),
};
```

### `DevtoolsDefect`

A command died, or an `on<Tag>` handler threw.

```ts continue
const died: DevtoolsDefect = {
  _tag: "Defect",
  name: "Counter",
  instance: "1",
  cause: { _tag: "Command", action: "Bumped", key: "save" },
  from: "Bumped",
  defect: { name: "Error", message: "network down" },
  handled: true,
};
```

`handled: true` means an `Error` handler took it and a `Transition` for the
`Error` action follows, with `cause: { _tag: "Defect" }`. `handled: false`
means React's error boundary took it.

## `DevtoolsCause`

```ts fragment
type DevtoolsCause =
  | { readonly _tag: "Dispatch" }
  | { readonly _tag: "Command"; readonly action: string; readonly key?: string }
  | { readonly _tag: "Lifecycle" }
  | { readonly _tag: "Defect"; readonly from: string };
```

```ts continue
const causes: ReadonlyArray<DevtoolsCause> = [
  { _tag: "Dispatch" }, // from React: an event handler, or a caller holding the store
  { _tag: "Command", action: "Bumped", key: "save" }, // emitted by a running command
  { _tag: "Lifecycle" }, // Mounted, PropsChanged, HookChanged or Unmounted
  { _tag: "Defect", from: "Bumped" }, // the Error action the runtime folded
];
```

`key` is present when the emitting command was `Command.keyed`. The name a
`Command.cancel` would use for that fiber is `key ?? action`.

There is no `Output` cause. What a parent does with an output happens in
user code the runtime cannot observe, so it never asserts that edge.

## Summaries

```ts continue
const commandSummary: CommandSummary = {
  _tag: "Batch",
  commands: [
    { _tag: "Cancel", target: "save" },
    { _tag: "Keyed", key: "save", command: { _tag: "Effect" } },
  ],
};

const defectSummary: DefectSummary = { name: "Error", message: "network down", stack: "..." };
```

`CommandSummary` mirrors the command ADT with the leaf's callback erased.
`DefectSummary` flattens an unknown thrown value to `{ name?, message, stack? }`,
because an `Error` serialises to `{}`.

## Redaction

Two actions reach a sink as their tag alone:

- `Error`, which holds a live `Error` and a `Cause`.
- `HookChanged`, which holds a record that routinely holds functions.

```ts continue
const scrubbed: ReadonlyArray<DevtoolsEvent> = [
  { ...transition, action: { _tag: "Error" }, cause: { _tag: "Defect", from: "Bumped" } },
  { ...transition, action: { _tag: "HookChanged" }, cause: { _tag: "Lifecycle" } },
];
```

`PropsChanged` keeps its `previous` props, with each opaque prop replaced by
its placeholder. A `Children` prop reports as `"<children>"`, which is what
keeps every event JSON round-trippable. The reducer's own snapshot keeps the
real node. See
[Children and opaque props](/docs/explanation/children-and-opaque-props).

```ts continue
const reported = { _tag: "PropsChanged", previous: { step: 1, children: "<children>" } };

const propsChanged: DevtoolsTransition = {
  ...transition,
  cause: { _tag: "Lifecycle" },
  action: reported,
};
```

State is not redacted. It reaches a sink verbatim, which is why `define` throws
when the state schema declares an opaque field.
