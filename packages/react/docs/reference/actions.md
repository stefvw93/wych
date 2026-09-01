---
title: Actions and outputs
description: Action, Action.output, Action.of, the two channels, reserved tags, Emit and NoOutputs.
order: 3
---

# Actions and outputs

A message is a `Schema.TaggedStruct` branded with a channel. `Action` builds
one on the internal channel, and `Action.output` builds one on the outbound
channel. `Action.of` collects members into a vocabulary.

Every snippet on this page builds on one vocabulary: the messages of a
checkout cart.

```ts
import { Schema } from "effect";
import { Action, Command, define } from "@wych/react";
import type { Emit, NoOutputs } from "@wych/react";

const Added = Action("Added", { sku: Schema.String, quantity: Schema.Number });
const Removed = Action("Removed", { sku: Schema.String });
const CheckoutRequested = Action("CheckoutRequested", {});

const OrderPlaced = Action.output("OrderPlaced", { orderId: Schema.String });
const Cancelled = Action.output("Cancelled", { reason: Schema.String });
```

## `Action`

```ts fragment
Action<Tag extends Capitalize<string>, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
): Message<Tag, Fields, "internal">
```

An action reaches the reducer. `_tag` is part of the schema, so a message is
encodable and a union discriminates on it.

```ts continue
console.log(Object.keys(Added.fields).sort());
// => ["_tag", "quantity", "sku"]
console.log(Added.make({ sku: "sku_1", quantity: 2 }));
// => { _tag: "Added", sku: "sku_1", quantity: 2 }
```

`make` fills `_tag`. `dispatch` takes the whole tagged message, and a reducer
handler receives the payload with `_tag` stripped.

The tag must be capitalized.

```ts continue
// @ts-expect-error "added" is not Capitalize<string>
const lowercase = Action("added", {});
```

## `Action.output`

```ts fragment
Action.output<Tag extends Capitalize<string>, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
): Message<Tag, Fields, "outbound">
```

An output leaves through an `on<Tag>` prop and never reaches the reducer.
`Command.output` is the only constructor that takes one.

```ts continue
const announce = Command.output(OrderPlaced, { orderId: "o_1" });

// @ts-expect-error Added is an internal message
const wrongChannel = Command.output(Added, { sku: "sku_1", quantity: 1 });
```

`Action.output` has a call signature and nothing else, so `Action.output.of`
does not exist. Build an outbound vocabulary with `Action.of`, which reads the
channel off its members.

## Channels

The two channels are branded, so a message of one is not assignable to the
other, even with the same tag and the same fields.

```ts continue
const InternalPing = Action("Ping", { at: Schema.Number });
const OutboundPing = Action.output("Ping", { at: Schema.Number });

// @ts-expect-error internal is not assignable to outbound
const asOutbound: typeof OutboundPing = InternalPing;

// @ts-expect-error outbound is not assignable to internal
const asInternal: typeof InternalPing = OutboundPing;
```

## Reserved lifecycle tags

`Mounted`, `PropsChanged`, `HookChanged`, `Error` and `Unmounted` are raised by
the runtime. Declaring one on either channel is a compile error.

```ts continue
// @ts-expect-error "Mounted" is a lifecycle tag
const reserved = Action("Mounted", {});

// @ts-expect-error "Unmounted" is a lifecycle tag
const reservedOutput = Action.output("Unmounted", {});
```

Their payloads and firing order are in [Lifecycle](/docs/reference/lifecycle).

## `Action.of`

```ts fragment
Action.of<Members extends ReadonlyArray<AnyMessage<Channel>>>(
  members: Members,
): Vocabulary<Members, ChannelOf<Members>>
```

`of` builds a tagged union from a member list. Every member must be on one
channel; a mixed list is a compile error.

```ts continue
const CartActions = Action.of([Added, Removed, CheckoutRequested]);
const CartOutputs = Action.of([OrderPlaced, Cancelled]);

// @ts-expect-error the member list straddles both channels
const mixed = Action.of([Added, OrderPlaced]);
```

### `cases`

A record from tag to member, each with its own `make`.

```ts continue
console.log(Object.keys(CartActions.cases));
// => ["Added", "Removed", "CheckoutRequested"]
console.log(CartActions.cases.Removed.make({ sku: "sku_1" }));
// => { _tag: "Removed", sku: "sku_1" }
```

The reducer keys off `cases`, so those tags are exactly the handlers a feature
owes.

### `guards`

One type guard per tag.

```ts continue
const message = CartActions.cases.Added.make({ sku: "sku_1", quantity: 2 });

console.log(CartActions.guards.Added(message));
// => true
console.log(CartActions.guards.Removed(message));
// => false
```

### `match`

```ts continue
const describe = CartActions.match(message, {
  Added: (added) => `+${added.quantity} ${added.sku}`,
  Removed: (removed) => `-${removed.sku}`,
  CheckoutRequested: () => "checkout",
});

console.log(describe);
// => "+2 sku_1"
```

`match` receives the whole member, `_tag` included. A reducer handler receives
the payload instead.

### Nesting

A vocabulary is itself a member. `of` flattens the inner `cases` into the outer
union, so a tag from an inner vocabulary is constructible and discriminable at
the outer one.

```ts continue
const AsyncActions = Action.of([
  Action("Started", {}),
  Action("Failed", { reason: Schema.String }),
]);
const AllActions = Action.of([AsyncActions, CheckoutRequested]);

console.log(Object.keys(AllActions.cases).sort());
// => ["CheckoutRequested", "Failed", "Started"]
console.log(AllActions.cases.Failed.make({ reason: "network" }));
// => { _tag: "Failed", reason: "network" }
```

This is how a [task](/docs/reference/tasks) contributes its two generated
actions: `Action.of([CheckoutRequested, ...checkout.actions])`.

## `Emit` and `NoOutputs`

```ts fragment
type Emit<A extends AnyVocabulary<"internal">, O extends AnyVocabulary<"outbound">> =
  MemberOf<A> | MemberOf<O>;

type NoOutputs = Vocabulary<readonly [], "outbound">;
```

`Emit` is what a command may emit and what `render`'s `dispatch` accepts: the
declared actions and the declared outputs. `NoOutputs` is the empty outbound
vocabulary, which is `define`'s default when no `output` is declared. Its
`Type` is `never`, so `OutputProps` degrades to `{}`.

```ts continue
type CartMessage = Emit<typeof CartActions, typeof CartOutputs>;
type LeafMessage = Emit<typeof CartActions, NoOutputs>;

const Cart = define({
  props: Schema.Struct({ customerId: Schema.String }),
  state: Schema.Struct({ items: Schema.Number }),
  action: CartActions,
  output: CartOutputs,
});

const cart = Cart.create({
  initialState: Cart.initialState(() => ({ items: 0 })),
  reducer: Cart.reducer({
    Added: ({ quantity }, { state }) => ({ items: state.items + quantity }),
    Removed: (_payload, { state }) => ({ items: state.items - 1 }),
    CheckoutRequested: (_payload, { state }) => [
      state,
      Command.output(OrderPlaced, { orderId: "o_1" }),
    ],
  }),
  render: Cart.render(() => null),
});
```

Two more rules bind the channels to `define`: an output tag equal to an action
tag is a compile error, and a prop named `on<OutputTag>` is a compile error.
Both are shown in [Features](/docs/reference/features). For the reasoning, see
[Actions and outputs](/docs/explanation/actions-and-outputs).
