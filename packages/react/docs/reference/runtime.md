---
title: Runtime
description: createRuntime, Provider, component, useRuntime, useFeature, output props and props validation.
order: 1
---

# Runtime

`createRuntime` builds the root of a Wych application. It owns one `ManagedRuntime`
over the root `Layer`, and it turns a `Feature` into a React component.

Every snippet on this page builds on one feature: a cart that places an order
through a `Checkout` service and announces the order id to its parent.

```tsx
import { Context, Effect, Layer, Schema } from "effect";
import { Action, Command, createRuntime, define } from "@wych/react";

class Checkout extends Context.Service<
  Checkout,
  { readonly place: (customerId: string) => Effect.Effect<string> }
>()("Checkout") {}

const CheckoutLayer = Layer.succeed(Checkout)({
  place: (customerId) => Effect.succeed(`order_for_${customerId}`),
});

const Added = Action("Added", { sku: Schema.String });
const Ordered = Action("Ordered", { orderId: Schema.String });
const OrderPlaced = Action.output("OrderPlaced", { orderId: Schema.String });

const Cart = define({
  props: Schema.Struct({ customerId: Schema.String }),
  state: Schema.Struct({ items: Schema.Array(Schema.String) }),
  action: Action.of([Added, Ordered]),
  output: Action.of([OrderPlaced]),
});

export const cart = Cart.create({
  initialState: Cart.initialState(() => ({ items: [] })),
  reducer: Cart.reducer({
    Added: ({ sku }, { state, props }) => [
      { items: [...state.items, sku] },
      Command.effect((dispatch) =>
        Effect.flatMap(Checkout, (checkout) => checkout.place(props.customerId)).pipe(
          Effect.flatMap((orderId) => dispatch({ _tag: "Ordered", orderId })),
        ),
      ),
    ],
    Ordered: ({ orderId }, { state }) => [state, Command.output(OrderPlaced, { orderId })],
  }),
  render: Cart.render(({ state, dispatch }) => (
    <button onClick={() => dispatch({ _tag: "Added", sku: "sku_1" })}>
      Add ({state.items.length})
    </button>
  )),
});
```

## `createRuntime`

```ts fragment
createRuntime<RootR, RootE>(
  layer: Layer.Layer<RootR, RootE>,
): { Provider; component; useRuntime }
```

One argument: the root `Layer`. Pass `Layer.empty` when the application has no
services.

```tsx continue
const { Provider, component, useRuntime } = createRuntime(CheckoutLayer);
```

The runtime is created once, at module scope. Its `ManagedRuntime` is built on
the first mount and lives for the life of the module.

## `Provider`

```ts fragment
Provider: FC<{ readonly children?: ReactNode }>;
```

`Provider` puts the runtime into React context.

```tsx continue
const CartView = component(cart, { name: "Cart" });

export const App = () => (
  <Provider>
    <CartView customerId="c_1" onOrderPlaced={({ orderId }) => console.log(orderId)} />
  </Provider>
);
```

`Provider` is optional. A component resolves the runtime it was created from,
so the tree above renders identically without it.

## `component`

```ts fragment
component(feature, options?: { readonly name?: string }): FeatureComponent
component(feature, options: { readonly layer: Layer; readonly name?: string }): FeatureComponent
```

The first overload takes a feature whose services `R` are covered by the root.
The second takes a feature that needs more, and a `layer` supplying the
residue `Exclude<R, RootR>`.

```tsx continue
class Analytics extends Context.Service<
  Analytics,
  { readonly track: (event: string) => Effect.Effect<void> }
>()("Analytics") {}

const AnalyticsLayer = Layer.succeed(Analytics)({ track: () => Effect.void });

const tracked = Cart.create({
  initialState: Cart.initialState(() => ({ items: [] })),
  reducer: Cart.reducer({
    Added: ({ sku }, { state }) => [
      { items: [...state.items, sku] },
      Command.effect(() => Effect.flatMap(Analytics, (a) => a.track(sku))),
    ],
    Ordered: ({ orderId }, { state }) => [state, Command.output(OrderPlaced, { orderId })],
  }),
  render: Cart.render(() => null),
});

const TrackedCart = component(tracked, { layer: AnalyticsLayer, name: "TrackedCart" });
```

A service that neither the root nor the feature layer provides is a compile
error at `component`, before anything mounts.

```tsx continue
// @ts-expect-error Analytics is not provided by the root layer
const Unprovided = component(tracked);
```

The feature layer is built once per mount and released when that mount closes.
Anything that must outlive a mount belongs in the root layer.

### `name`

`name` defaults to `"TeaFeature"`. It appears in the component's
`displayName`, in `useFeature` error messages, and as the `name` field of every
[devtools event](/docs/reference/devtools).

```tsx continue
const Anonymous = component(cart);

console.log(CartView.displayName);
// => "Cart"
console.log(Anonymous.displayName);
// => "TeaFeature"
```

## Output props

Every declared output becomes a required `on<Tag>` prop. The payload arrives
with `_tag` stripped, because the prop name already carries the tag.

```ts fragment
type OutputProps<Output extends { readonly _tag: string }> = {
  readonly [K in Output["_tag"] as `on${K}`]: (payload: Omit<..., "_tag">) => void;
};
```

```tsx continue
const parent = <CartView customerId="c_1" onOrderPlaced={({ orderId }) => console.log(orderId)} />;

// @ts-expect-error Property 'onOrderPlaced' is missing
const missing = <CartView customerId="c_1" />;
```

A feature that declares no outputs gets `{}`, so the prop set is its props
schema alone.

An output that leaves while its `on<Tag>` prop is absent throws to the nearest
React error boundary. Absence is unreachable through JSX, since the prop is
required.

```ts fragment
// throws TypeError: No "onOrderPlaced" prop for output "OrderPlaced"
```

Outputs never re-enter the reducer. See
[Actions and outputs](/docs/explanation/actions-and-outputs).

## Props validation

Props are validated against the props schema with `onExcessProperty: "error"`
and `errors: "all"`. Validation runs on mount and on every props identity
change, and it does not run for a state-driven re-render.

```tsx continue
import { renderToString } from "react-dom/server";

renderToString(<CartView customerId={1 as unknown as string} onOrderPlaced={() => {}} />);
// throws TypeError: Invalid props for <Cart>:
```

The `TypeError` reaches the nearest React error boundary. Its message lists
every problem with its path. Props are validated, never decoded: `define`
normalizes the props schema to its `Type` side, so a transforming field is
never re-decoded on a parent render.

## `FeatureComponent.useFeature`

```ts fragment
CartView.useFeature(): RenderSnapshot<Props, State, Action | Output, H>
```

`useFeature` returns the same `{ state, props, hooks, dispatch }` object that
`render` received on that render. Use it for a view fragment that is part of
the feature's view and lives in its own file.

```tsx continue
const ItemCount = () => {
  const { state, dispatch } = CartView.useFeature();
  return (
    <button onClick={() => dispatch({ _tag: "Added", sku: "sku_2" })}>
      {state.items.length} items
    </button>
  );
};
```

`dispatch` accepts declared actions and declared outputs. It is reference-stable
for the life of the mount.

```tsx continue
const AnnounceButton = () => {
  const { dispatch } = CartView.useFeature();
  // An output dispatched from the view leaves through onOrderPlaced.
  return <button onClick={() => dispatch({ _tag: "OrderPlaced", orderId: "o_1" })}>Ship</button>;
};
```

Called outside a mount of that component, `useFeature` throws.

```tsx continue
renderToString(<ItemCount />);
// throws TypeError: Cart.useFeature() called outside <Cart>
```

Two `component()` calls over one feature have separate contexts, so
`Anonymous.useFeature()` under `<CartView>` throws. Do not call `useFeature`
inside `render`; `render` already has the snapshot as its argument.

## `useRuntime`

```ts fragment
useRuntime(): ManagedRuntime.ManagedRuntime<RootR, RootE>
```

The escape hatch for plain React components that are not features.

```tsx continue
const PlaceOrderButton = () => {
  const runtime = useRuntime();
  return (
    <button
      onClick={() => runtime.runFork(Effect.flatMap(Checkout, (checkout) => checkout.place("c_1")))}
    >
      Place order
    </button>
  );
};
```

## Server rendering

`renderToString` paints `initialState(props)`, validates props, and resolves
`useFeature` fragments. Nothing folds: no `Mounted`, no commands, no store
arming, because the arming lives in an effect. See
[Render on the server](/docs/how-to/render-on-the-server).
