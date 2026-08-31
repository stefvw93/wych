---
title: Features
description: define, create, lifecycle actions, and the Next accessors.
order: 3
---

# Features

## Lifecycle actions

Five tags are reserved and dispatched by the runtime, not by you:

| Tag            | When                             |
| -------------- | -------------------------------- |
| `Mounted`      | once per mount                   |
| `PropsChanged` | props changed by value           |
| `HookChanged`  | an ambient hook changed by value |
| `Error`        | a command produced a defect      |
| `Unmounted`    | at teardown                      |

Using a lifecycle tag as one of your own message tags is a compile error. An
unhandled lifecycle action leaves state unchanged and does not throw — a missing
handler for anything else throws, which is reachable only by bypassing the typed
surface.

`PropsChanged` and `HookChanged` are detected **by value** — props through
`Schema.toEquivalence`, hooks through record equality on `Object.is`.

`Unmounted`'s handler runs, but its returned state is discarded. Only its
command matters.

## `Next` accessors

A handler returns a `Next`: a bare state, or a `[state, command]` tuple.

```ts
import { Next } from "@wych/react";

Next.state(next); // the state, either way
Next.command(next); // the command, or undefined for a bare state
```

`Next.command` resolves a lazy command by calling it once with the tuple's own
state, so every consumer sees it already resolved.

## Opaque props: `children`

Props are schema values — validated, never decoded. A React node is none of
those things, so `children` is _declared_ rather than described:

```ts
import { Children } from "@wych/react";

const Props = Schema.Struct({ children: Children });
```

`Children` has three deliberate properties:

- **It validates anything.** React already owns the question of what it can
  render.
- **It is invisible to change detection.** Its equivalence is constantly `true`,
  so new children alone never raise `PropsChanged`. The corollary — a reducer's
  `snapshot.props.children` may be stale — is accepted; `render` is unaffected.
- **It is redacted in devtools.** `PropsChanged`'s reported `previous` replaces
  each opaque prop with a placeholder, which keeps every devtools event
  JSON-round-trippable.

`Children.as<T>()` is the same declaration at any children type — a render prop,
one element, a tuple of slots:

```ts
children: Children.as<(row: Row) => ReactNode>();
```

Declared plainly it is **required**: JSX that passes no children omits the key
entirely, so the call site is a compile error. `Schema.optionalKey(Children)` is
the optional form. There is no third state.

## Testing without React

`reduce` is one pure function:

```ts
const next = counter.reduce({ _tag: "Bumped" }, { state, props, hooks });
```

`run` folds a sequence to quiescence and reports what happened:

```ts
const { state, emitted, outputs } = await counter.run([{ _tag: "Bumped" }], { layer });
```

Seeded actions are processed but not recorded in `emitted`; actions a command
emits feed back into the reducer loop and are collected. `run` resolves only at
quiescence — nothing queued, nothing in flight — so it does **not** terminate on
a never-completing command.

## Server rendering

`renderToString` renders a feature server-side: `initialState(props)` paints and
`validateProps` still throws on bad props, but **nothing folds** — no `Mounted`,
no commands, no store arming, because the arming lives in an effect and effects
do not run on the server.
