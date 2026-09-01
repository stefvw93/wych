---
title: Children and opaque props
description: Why a React node cannot be a schema value, and what Children gives up to carry one.
order: 5
---

Props are validated, never decoded. `define` normalizes the props schema with `Schema.toType`, so a transforming field surfaces as its decoded type and the parent passes decoded values. Validation runs with `onExcessProperty: "error"` on mount and on every props identity change.

```tsx
import { Action, Children, createRuntime, define } from "@wych/react";
import { Layer, Schema } from "effect";
import type { ReactNode } from "react";

const Toggled = Action("Toggled", {});

const Panel = define({
  props: Schema.Struct({ title: Schema.String, children: Children }),
  state: Schema.Struct({ open: Schema.Boolean }),
  action: Action.of([Toggled]),
});
```

`children` is declared, and the declaration describes nothing. A React node has no encoded side to decode from, it is a fresh object on every parent render, and printing one into a devtools event dumps an element tree. There is no schema shape that would be true of it.

## Three properties, one annotation

`Children` is a `Schema.declare` carrying the `"@wych/opaque"` annotation, whose value is the placeholder string. It has three properties, each chosen.

**It validates anything.** `ReactNode` is wide and recursive, a function's shape is unobservable, and React already owns the question of what it can render. A schema-side re-derivation could only disagree with the renderer.

```tsx continue
const panel = Panel.create({
  initialState: () => ({ open: false }),
  reducer: {
    Toggled: (_payload, { state }) => ({ ...state, open: !state.open }),
    PropsChanged: ({ previous }, { state }) => ({ ...state, open: previous.title !== "" }),
  },
  render: ({ state, props, dispatch }) => (
    <section>
      <button onClick={() => dispatch({ _tag: "Toggled" })}>{props.title}</button>
      {state.open ? props.children : null}
    </section>
  ),
});
```

**It is invisible to change detection.** Its `toEquivalence` annotation is constantly `true`, so a new node alone never raises `PropsChanged`. The default equivalence for a declaration compares by reference, and a fresh node every parent render would re-run the reducer on every parent render.

**It is redacted in devtools.** `PropsChanged.previous` reports `"<children>"` in place of the node, which keeps every devtools event JSON round-trippable. Redaction happens at the report site only, so the reducer's snapshot holds the real node.

## The staleness that follows

When only children change, the store keeps its previous props object. A reducer reading `snapshot.props.children` can therefore hold the node from an earlier render.

```tsx continue
const stale = Panel.reducer({
  Toggled: (_payload, { state, props }) => {
    props.children; // may be an earlier render's node
    return { ...state, open: !state.open };
  },
});
```

`render` is unaffected. It reads the component's own props, so it always paints the current node. The trade is deliberate: children are for rendering, and a reducer that needs to reduce over them wants data in a declared prop.

## Why `define` refuses `Children` in state

Redaction covers `PropsChanged.previous`. A devtools `Transition` reports state verbatim, so a state schema holding a node would put raw React elements into every event.

```tsx continue
define({
  props: Schema.Struct({ title: Schema.String }),
  state: Schema.Struct({ slot: Children }),
  action: Action.of([Toggled]),
});
// throws TypeError: Opaque field "slot" declared in the state schema
```

The throw is at `define`, so the mistake surfaces at the declaration, before any devtools output is unreadable.

`children` is the only opaque prop the library ships. A general `opaque<T>(placeholder)` combinator was built and withdrawn, because the annotation and the collection are already general and one caller does not need a public surface.

## Three ways to split a view

A view fragment belongs to the feature. It reads the same snapshot `render` got, through the hook on the component.

```tsx continue
const runtime = createRuntime(Layer.empty);
const PanelView = runtime.component(panel, { name: "Panel" });

const Title = () => {
  const { props, dispatch } = PanelView.useFeature();
  return <h2 onClick={() => dispatch({ _tag: "Toggled" })}>{props.title}</h2>;
};
```

A child feature is a `Feature` of its own, built with `create` and mounted with `component`. It has its own state and vocabularies, and it talks through validated props and `on<Tag>` callbacks. Reach for it when the part has a model of its own.

A render prop is children the feature calls. `Children.as<T>()` is the same declaration at whatever type the feature accepts.

```tsx
import { Action, Children, define } from "@wych/react";
import { Schema } from "effect";
import type { ReactNode } from "react";

const Toggled = Action("Toggled", {});

const Panel = define({
  props: Schema.Struct({
    title: Schema.String,
    children: Children.as<(open: boolean) => ReactNode>(),
  }),
  state: Schema.Struct({ open: Schema.Boolean }),
  action: Action.of([Toggled]),
});

const panel = Panel.create({
  initialState: () => ({ open: false }),
  reducer: { Toggled: (_payload, { state }) => ({ ...state, open: !state.open }) },
  render: ({ state, props }) => <section>{props.children(state.open)}</section>,
});
```

The type argument is the whole contract. Nothing in the runtime reads the value, so there is no shape for the schema to check and none for it to lie about. Optional children are `Schema.optionalKey(Children)`; declared plainly the key is required, and JSX that passes none omits it.

Signatures for `Children` and the definition helpers are in [features](/docs/reference/features). `useFeature` and props validation are in [runtime](/docs/reference/runtime).
