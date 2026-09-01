---
title: Test a feature without React
description: Fold actions with reduce and run, supply a test layer, and record the devtools stream.
order: 3
example: cart-tests
---

# Test a feature without React

A feature is a value. `feature.reduce` folds one action, `feature.run` folds a sequence and runs the commands. Neither touches the DOM.

## The feature under test

```ts
import { Action, Command, define, Next, Task } from "@wych/react";
import { Context, Effect, Layer, Schema } from "effect";
import { expect, test } from "vite-plus/test";

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
  run: (total: number) => Effect.flatMap(Payments, (api) => api.charge(total)),
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

You supply the snapshot, so there is no initial state to build. `run` builds it from the props.

## A sequence with run

`run` folds the actions you seed, runs every command against the layer, and folds what those commands dispatch. It resolves at quiescence.

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

The three results answer three questions:

- `state`: what the fold accumulated.
- `emitted`: what the commands dispatched back in. Seeded actions are absent.
- `outputs`: what left through the outbound channel. Outputs are collected and never folded.

A command that never completes never reaches quiescence, so `run` never resolves. Give a long-lived source a finite stream, as in [subscribe to a stream](/docs/how-to/subscribe-to-a-stream).

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

Events come from a mounted component. `feature.reduce` and `feature.run` report nothing to devtools, so mount `<Cart onOrdered={() => {}} />` with your React test renderer before reading the stream. The event shapes are in the [devtools reference](/docs/reference/devtools).

```ts continue
test("transitions are filterable by tag", () => {
  const transitions = recorder.events.filter((event) => event._tag === "Transition");
  expect(transitions).toEqual([]);
});
```

Emission is synchronous, so everything a mount was going to report is in `events` by the time its effect settles.
