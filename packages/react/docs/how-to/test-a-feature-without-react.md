---
title: Test a feature without React
description: Fold actions with reduce and run, supply a test layer, and record the devtools stream.
order: 3
example: cart-tests
---

# Test a feature without React

A reducer that lives behind a component is tested through the component: render it, click, await the effect, read the DOM. Every assertion pays for a renderer, and a request race is only reachable through timing.

A feature is a value, so its tests are plain function calls. Three tools cover three kinds of claim:

- `feature.reduce` for one transition: from this state, this action gives this state and asks for this command. Nothing runs.
- `feature.run` for a sequence: with this layer, these actions end in this state, emitted these actions and these outputs. Commands run.
- `createRecorder` for what a mount reported: transitions, commands, defects. A component must be mounted.

## The feature under test

```ts
import { Action, Command, define, Next, Task } from "@wych/react";
import { Context, Effect, Layer, Schema } from "effect";
import { expect, test } from "vitest";

const Item = Schema.Struct({ id: Schema.String, price: Schema.Number });

class Payments extends Context.Service<
  Payments,
  { readonly charge: (total: number) => Effect.Effect<string, Error> }
>()("Payments") {}

const Added = Action("Added", { id: Schema.String, price: Schema.Number });
const Submitted = Action("Submitted", {});
const Ordered = Action.output("Ordered", { total: Schema.Number });

const charge = Task("Charge", {
  success: Schema.String,
  onError: Task.message,
  run: (total: number) =>
    Effect.gen(function* () {
      const api = yield* Payments;
      return yield* api.charge(total);
    }),
});

const total = (items: ReadonlyArray<{ readonly price: number }>) =>
  items.reduce((sum, item) => sum + item.price, 0);

const cart = define({
  props: Schema.Struct({}),
  state: Schema.Struct({
    items: Schema.Array(Item),
    charge: Task.schema(Schema.String),
  }),
  action: Action.of([Added, Submitted, ...charge.actions]),
  output: Action.of([Ordered]),
}).create({
  initialState: () => ({ items: [], charge: Task.idle }),
  reducer: {
    Added: (item, { state }) => ({ ...state, items: [...state.items, item] }),
    Submitted: (_payload, { state }) => Task.start(state, "charge", charge.run(total(state.items))),
    ChargeResolved: ({ value }, { state }) => [
      { ...state, charge: Task.resolved(value) },
      Command.output(Ordered, { total: total(state.items) }),
    ],
    ChargeRejected: ({ error }, { state }) => ({ ...state, charge: Task.rejected(error) }),
  },
  render: () => null,
});
```

The payment provider is a service, so each test picks its own `Payments` layer. `render` returns `null`: nothing on this page mounts the feature, and the view is a separate concern.

## One step with reduce

`reduce` takes an action and a snapshot, and returns a `Next`. `Next.state` and `Next.command` read the two halves, so a test never destructures a tuple.

```ts continue
const empty = { items: [], charge: Task.idle } as const;

test("Added appends and issues no command", () => {
  const next = cart.reduce(Added.make({ id: "a", price: 10 }), {
    state: empty,
    props: {},
    hooks: {},
  });

  expect(Next.state(next).items).toEqual([{ id: "a", price: 10 }]);
  expect(Next.command(next)).toBeUndefined();
  // => Next.command of a bare state is undefined
});
```

Pick `reduce` when the claim is about one transition. You supply the snapshot, so any state is one object literal away, and there is no layer to build.

`reduce` runs nothing. A handler that returns a command hands you the command as data, so a test can assert that work was requested without running it.

```ts continue
test("Submitted writes Pending and issues a command", () => {
  const next = cart.reduce(Submitted.make({}), {
    state: { items: [{ id: "a", price: 10 }], charge: Task.idle },
    props: {},
    hooks: {},
  });

  expect(Next.state(next).charge).toEqual({ _tag: "Pending" });
  expect(Next.command(next)).toBeDefined();
});
```

A claim about what the command does once it runs is out of reach here. That claim belongs to `run`.

## A sequence with run

`run` builds the initial state from the props, folds the actions you seed, runs every command against the layer, and folds what those commands dispatch. It resolves once nothing is queued and nothing is in flight.

```ts continue
const paid = Layer.succeed(Payments)({
  charge: (amount) => Effect.succeed(`receipt-${amount}`),
});

test("a paid cart resolves the task and announces the order", async () => {
  const { state, emitted, outputs } = await Effect.runPromise(
    cart.run([Added.make({ id: "a", price: 10 }), Submitted.make({})], {
      props: {},
      hooks: {},
      layer: paid,
    }),
  );

  expect(state.charge).toEqual({ _tag: "Resolved", value: "receipt-10" });
  expect(emitted).toEqual([{ _tag: "ChargeResolved", value: "receipt-10" }]);
  expect(outputs).toEqual([{ _tag: "Ordered", total: 10 }]);
});
```

Pick `run` when the claim spans a command and its result. The three results answer three questions:

- `state`: what the fold accumulated.
- `emitted`: what the commands dispatched back in. Seeded actions are absent.
- `outputs`: what left through the outbound channel. Outputs are collected and never folded.

After each seeded action is reduced and its command started, `run` yields once, so that command's fiber reaches its first suspension before the next action is reduced. Seeded actions therefore behave like dispatches separated by an event-loop turn, and a race between two of them is testable.

```ts continue
const slow = Layer.succeed(Payments)({
  charge: (amount) => Effect.delay(Effect.succeed(`receipt-${amount}`), "10 millis"),
});

test("a second Submitted supersedes the charge in flight", async () => {
  const { emitted, outputs } = await Effect.runPromise(
    cart.run(
      [
        Added.make({ id: "a", price: 10 }),
        Submitted.make({}),
        Added.make({ id: "b", price: 5 }),
        Submitted.make({}),
      ],
      { props: {}, hooks: {}, layer: slow },
    ),
  );

  expect(emitted).toEqual([{ _tag: "ChargeResolved", value: "receipt-15" }]);
  expect(outputs).toEqual([{ _tag: "Ordered", total: 15 }]);
});
```

The first charge is asleep in `Effect.delay` when the second `Submitted` folds. `Task` runs in `"latest"` mode by default, so `Task.start` restarts the group and interrupts that fiber. An interrupted task dispatches nothing, which is why `emitted` holds one `ChargeResolved`.

Two claims stay out of `run`'s reach:

- A command that never completes keeps `run` from resolving. Give a long-lived source a finite stream, or seed `Unmounted` so its handler cancels the group, as in [subscribe to a stream](/docs/how-to/subscribe-to-a-stream).
- A command that dies is discarded. `run` resolves with the state it already had and an empty `emitted`, so a test of "given a failing command, this feature recovers" passes without checking anything. Route failures through `Task`'s `onError`, which turns them into a `Rejected` action, and test a raw defect with a mounted component and the recorder. [Commands as data](/docs/explanation/commands-as-data) has the reasoning.

## Supply a test layer

The layer is a plain argument, so the failure path is a second layer over the same feature.

```ts continue
const declined = Layer.succeed(Payments)({
  charge: () => Effect.fail(new Error("card declined")),
});

test("a declined charge rejects the task and announces nothing", async () => {
  const { state, outputs } = await Effect.runPromise(
    cart.run([Added.make({ id: "a", price: 10 }), Submitted.make({})], {
      props: {},
      hooks: {},
      layer: declined,
    }),
  );

  expect(state.charge).toEqual({ _tag: "Rejected", error: "card declined" });
  expect(outputs).toEqual([]);
});
```

`Task.message` mapped the `Cause` to its message. `onError` covers typed failures and defects, so a bug inside the effect lands in the field. The `Error` lifecycle handler never sees it.

For a feature with no services, pass `Layer.empty`.

## Assert on the devtools stream

`createRecorder` is an in-memory sink. Install it with `devtoolsLayer(recorder.sink)` and read `recorder.events` after the work.

```ts continue
import { createRecorder, createRuntime, devtoolsLayer } from "@wych/react";

const recorder = createRecorder();
const { component } = createRuntime(Layer.mergeAll(paid, devtoolsLayer(recorder.sink)));
const Cart = component(cart, { name: "Cart" });

test("the recorder starts empty", () => {
  expect(recorder.events).toEqual([]);
  recorder.clear();
});
```

Pick the recorder when the claim is about what a mount reported: the order of transitions, the commands issued, a defect a command raised. Events come from a mounted component. `feature.reduce` and `feature.run` report nothing to devtools, so mount `<Cart onOrdered={() => {}} />` with your React test renderer before reading the stream. The event shapes are in the [devtools reference](/docs/reference/devtools).

```ts continue
test("transitions are filterable by tag", () => {
  const transitions = recorder.events.filter((event) => event._tag === "Transition");
  expect(transitions).toEqual([]);
});
```

Emission is synchronous, so everything a mount was going to report is in `events` by the time its effect settles.
