---
title: Children and opaque props
description: Why a React node cannot be a schema value, and what Children gives up to carry one.
order: 5
---

# Children and opaque props

A data table takes rows as data and a row renderer as a function. In React
both are props and both are `any` at runtime. Wych validates props against a
schema, which raises a question a plain component never has to answer: what
is the schema of a React node?

There is none. A node has no encoded side to decode from, it is a fresh
object on every parent render, and printing one into a devtools event dumps
an element tree. So `children` is declared rather than described.

```tsx
import { Action, Children, createRuntime, define } from "@wych/react";
import { Layer, Schema } from "effect";
import type { ReactNode } from "react";

const Row = Schema.Struct({ id: Schema.String, name: Schema.String, size: Schema.Number });

const Sorted = Action("Sorted", { by: Schema.String });
const Selected = Action("Selected", { id: Schema.String });

const Table = define({
  props: Schema.Struct({
    rows: Schema.Array(Row),
    children: Children.as<(row: typeof Row.Type, selected: boolean) => ReactNode>(),
    empty: Schema.optionalKey(Children),
  }),
  state: Schema.Struct({ sortBy: Schema.String, selected: Schema.String }),
  action: Action.of([Sorted, Selected]),
});
```

`rows` is a schema value: validated on mount and on every props change, with
an unknown key or a wrong type thrown to the error boundary. `children` and
`empty` are `Children`: accepted as given, at the type the feature declares.

## Three properties, one annotation

`Children` is a `Schema.declare` carrying one annotation, `"@wych/opaque"`,
whose value is the placeholder devtools print. Three things follow from it,
each chosen.

**It validates anything.** `ReactNode` is wide and recursive, a function's
shape is unobservable, and React already owns the question of what it can
render. A schema-side re-derivation could only disagree with the renderer.
The type argument to `Children.as<T>()` is the whole contract, and the
compiler holds callers to it.

```tsx continue
const table = Table.create({
  initialState: () => ({ sortBy: "name", selected: "" }),
  reducer: {
    Sorted: ({ by }, { state }) => ({ ...state, sortBy: by }),
    Selected: ({ id }, { state }) => ({ ...state, selected: id }),
  },
  render: ({ state, props, dispatch }) =>
    props.rows.length === 0 ? (
      <>{props.empty}</>
    ) : (
      <table>
        <thead>
          <tr>
            <th onClick={() => dispatch(Sorted.make({ by: "name" }))}>Name</th>
            <th onClick={() => dispatch(Sorted.make({ by: "size" }))}>Size</th>
          </tr>
        </thead>
        <tbody>
          {[...props.rows]
            .sort((a, b) =>
              state.sortBy === "size" ? a.size - b.size : a.name.localeCompare(b.name),
            )
            .map((row) => (
              <tr key={row.id} onClick={() => dispatch(Selected.make({ id: row.id }))}>
                {props.children(row, row.id === state.selected)}
              </tr>
            ))}
        </tbody>
      </table>
    ),
});
```

**It is invisible to change detection.** Its equivalence is constantly
`true`, so a new node alone never raises `PropsChanged`. The default
equivalence for a declaration compares by reference, and a parent that
passes a fresh arrow function every render would re-run the reducer on
every parent render.

**It is redacted in devtools.** `PropsChanged.previous` reports
`"<children>"` in place of the node, which keeps every devtools event JSON
round-trippable. Redaction happens at the report site only; the reducer's
snapshot holds the real value.

## The staleness that follows

When only children change, the store keeps its previous props object. A
reducer reading `snapshot.props.children` can therefore hold the function
from an earlier render.

```tsx continue
const stale = Table.reducer({
  Sorted: ({ by }, { state, props }) => {
    props.children; // may be an earlier render's function
    return { ...state, sortBy: by };
  },
  Selected: ({ id }, { state }) => ({ ...state, selected: id }),
});
```

`render` is unaffected. It reads the component's own props, so it always
paints the current node. The trade is deliberate: children are for
rendering. A reducer that needs to fold over what the parent passed wants
data in a declared prop, as `rows` is, where the schema can see it.

## Why `define` refuses `Children` in state

Redaction covers `PropsChanged.previous`. A devtools `Transition` reports
state verbatim, so a state schema holding a node would put raw React
elements into every event. `define` throws at the declaration, before any
devtools output is unreadable.

```tsx continue
define({
  props: Schema.Struct({ rows: Schema.Array(Row) }),
  state: Schema.Struct({ slot: Children }),
  action: Action.of([Sorted]),
});
// throws TypeError: Opaque field "slot" declared in the state schema
```

`children` is the only opaque prop the library ships. A general
`opaque<T>(placeholder)` combinator was built and withdrawn: the annotation
and the collection are already general, and one caller does not justify a
public surface.

## Three ways to split a view

`render` is one function, and a table's view has parts. Which mechanism
splits it is a question of ownership.

A **view fragment** belongs to the feature. It reads the same snapshot
`render` got, through the hook on the component, and takes no props.

```tsx continue
const runtime = createRuntime(Layer.empty);
const DataTable = runtime.component(table, { name: "DataTable" });

const SortIndicator = () => {
  const { state } = DataTable.useFeature();
  return <caption>sorted by {state.sortBy}</caption>;
};
```

A **render prop** is children the feature calls, with data only the feature
has. The parent owns how a row looks; the table owns which row is selected.
That is `Children.as<(row, selected) => ReactNode>()` above.

```tsx continue
const FileList = () => (
  <DataTable rows={[{ id: "a", name: "a.txt", size: 12 }]} empty={<p>No files</p>}>
    {(row, selected) => (
      <td style={{ fontWeight: selected ? "bold" : "normal" }}>
        {row.name} ({row.size} B)
      </td>
    )}
  </DataTable>
);
```

A **child feature** is a `Feature` of its own, built with `create` and
mounted with `component`. It has its own state and vocabularies and talks
through validated props and `on<Tag>` callbacks. Reach for it when the part
has a model of its own: a row editor with a pending save is a child feature,
a row that only paints is a render prop.

Optional children are `Schema.optionalKey(Children)`, as `empty` is.
Declared plainly the key is required, because JSX that passes none omits
the key. Signatures for `Children` and the definition helpers are in
[features](/docs/reference/features). `useFeature` and props validation are
in [runtime](/docs/reference/runtime).
