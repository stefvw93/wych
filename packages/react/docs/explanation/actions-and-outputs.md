---
title: Actions and outputs
description: Why a feature has two message channels, and why the outbound one never reaches the reducer.
order: 2
---

A feature has two vocabularies. Actions come in and reach the reducer. Outputs go out and leave through a prop.

```ts
import { Action, Command, createRuntime, define, Next } from "@wych/react";
import { Effect, Layer, Schema } from "effect";

const Added = Action("Added", { sku: Schema.String });
const CheckedOut = Action("CheckedOut", {});
const OrderPlaced = Action.output("OrderPlaced", { orderId: Schema.String });

const Cart = define({
  props: Schema.Struct({ customerId: Schema.String }),
  state: Schema.Struct({ items: Schema.Array(Schema.String), placed: Schema.Boolean }),
  action: Action.of([Added, CheckedOut]),
  output: Action.of([OrderPlaced]),
});
```

`Action` brands a message internal and `Action.output` brands it outbound. The brand is a real runtime property, and the two channels are not assignable to each other in either direction. One vocabulary holds one channel.

```ts continue
// @ts-expect-error a vocabulary holds one channel
const Mixed = Action.of([Added, OrderPlaced]);
```

## Why an output never re-enters the reducer

A feature's state is a fold over its own action union. If an outbound message could also be folded, the reducer would have to answer a question the feature cannot answer: what the parent did with it.

```ts continue
const cart = Cart.create({
  initialState: () => ({ items: [], placed: false }),
  reducer: {
    Added: ({ sku }, { state }) => ({ ...state, items: [...state.items, sku] }),
    CheckedOut: (_payload, { state }) => [
      { ...state, placed: true },
      Command.output(OrderPlaced, { orderId: `order-${state.items.length}` }),
    ],
  },
  render: () => null,
});
```

The reducer's key set holds the declared action tags plus the optional lifecycle tags. An output tag is absent from it, so there is no handler to write. `reduce` refuses one at the call as well.

```ts continue
cart.reduce(
  // @ts-expect-error an output never reaches the reducer
  { _tag: "OrderPlaced", orderId: "o1" },
  { state: { items: [], placed: false }, props: { customerId: "c1" }, hooks: {} },
);
// throws TypeError: No reducer handler for action "OrderPlaced"
```

`run` shows the split. Actions a command emits are folded and collected in `emitted`. Outputs are collected in `outputs` and folded nowhere.

```ts continue
Effect.runPromise(
  cart.run([{ _tag: "Added", sku: "sku-1" }, { _tag: "CheckedOut" }], {
    props: { customerId: "c1" },
    hooks: {},
    layer: Layer.empty,
  }),
);
// => { state: { items: ["sku-1"], placed: true },
//      emitted: [],
//      outputs: [{ _tag: "OrderPlaced", orderId: "order-1" }] }
```

The runtime cannot attribute what the parent dispatches next to the output that caused it, because an output leaves through a plain React callback into arbitrary code. Devtools report the `Output` event and the parent's own `Dispatch` cause, and claim no edge between them.

## Why `_tag` is stripped at both edges

Each output becomes a required `on<Tag>` prop that receives the payload alone.

```tsx continue
const runtime = createRuntime(Layer.empty);
const CartView = runtime.component(cart, { name: "Cart" });

const Checkout = () => (
  <CartView customerId="c1" onOrderPlaced={({ orderId }) => window.alert(orderId)} />
);
```

The prop name already carries the tag, so the payload carries no discriminant to destructure around. A reducer handler is stripped on the same rule: the handler key did the routing, so what the handler holds is plain data. Storing a payload whole cannot smuggle a tag into state or into a command's payload.

```ts continue
const next = cart.reduce(
  { _tag: "Added", sku: "sku-1" },
  { state: { items: [], placed: false }, props: { customerId: "c1" }, hooks: {} },
);
// the handler received { sku: "sku-1" }
Next.state(next); // => { items: ["sku-1"], placed: false }
```

A missing `on<Tag>` handler at runtime throws `TypeError('No "onOrderPlaced" prop for output "OrderPlaced"')` to the nearest error boundary. The parent owes a handler for every output the child declares.

## Why `dispatch` routes outputs from the view

`render` and `Component.useFeature()` both hand back a `dispatch` that accepts declared actions and declared outputs. The store routes every message by tag, so an output dispatched from the view goes straight to its prop.

```tsx continue
const passthrough = Cart.render(({ dispatch }) => (
  <button onClick={() => dispatch(OrderPlaced.make({ orderId: "o1" }))}>announce</button>
));
```

Without that route, a view that only announces would need a mirror action whose single job is to return `Command.output`. That handler writes no state and exists to satisfy the plumbing.

## When state must witness what left

Route through an action when the feature's own state has to record the announcement. The view dispatches the action, the handler writes state, and the command carries the output out.

```ts continue
const checkout = Cart.reducer({
  Added: ({ sku }, { state }) => ({ ...state, items: [...state.items, sku] }),
  CheckedOut: (_payload, { state }) => [
    { ...state, placed: true },
    Command.output(OrderPlaced, { orderId: `order-${state.items.length}` }),
  ],
});
```

`placed: true` is the witness. The output still leaves once, from the same fold that wrote the state, so the two cannot come apart.

## Why lifecycle tags are reserved

The runtime raises `Mounted`, `PropsChanged`, `HookChanged`, `Error` and `Unmounted` into the same reducer, using the same key lookup. A user message with one of those tags would be indistinguishable from the runtime's own.

```ts continue
// @ts-expect-error "Mounted" is a lifecycle tag
const Mounted = Action("Mounted", {});
```

The five tags are rejected at declaration, in both channels, so the collision is a compile error at the line that causes it. Payloads and firing order are in [lifecycle](/docs/reference/lifecycle); the vocabulary API is in [actions](/docs/reference/actions).
