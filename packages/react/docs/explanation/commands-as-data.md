---
title: Commands as data
description: Why the reducer returns a description of work and the runtime interprets it.
order: 3
---

A handler returns the next state and, beside it, a `Command`. A command is a small value describing work. Nothing in a handler runs.

```ts
import { Action, Command, define, Next } from "@wych/react";
import { Context, Effect, Layer, Schema } from "effect";

class Search extends Context.Service<
  Search,
  { readonly query: (text: string) => Effect.Effect<ReadonlyArray<string>> }
>()("Search") {}

const TextEdited = Action("TextEdited", { text: Schema.String });
const HitsArrived = Action("HitsArrived", { hits: Schema.Array(Schema.String) });

const SearchBox = define({
  props: Schema.Struct({ placeholder: Schema.String }),
  state: Schema.Struct({ text: Schema.String, hits: Schema.Array(Schema.String) }),
  action: Action.of([TextEdited, HitsArrived]),
});
```

The reducer stays a pure function of `(payload, snapshot)`. That is what makes `feature.reduce` callable in a test, `feature.run` able to fold a sequence, and a devtools transition a pair of plain values.

```ts continue
const searchBox = SearchBox.create({
  initialState: () => ({ text: "", hits: [] }),
  reducer: {
    TextEdited: ({ text }, { state }) => [
      { ...state, text },
      Command.restart(
        "query",
        Command.effect((dispatch) =>
          Effect.sleep("300 millis").pipe(
            Effect.flatMap(() => Effect.flatMap(Search, (search) => search.query(text))),
            Effect.flatMap((found) => dispatch({ _tag: "HitsArrived" as const, hits: found })),
          ),
        ),
      ),
    ],
    HitsArrived: ({ hits }, { state }) => ({ ...state, hits }),
  },
  render: () => null,
});
```

The command the handler returned is readable before anything runs.

```ts continue
const next = searchBox.reduce(
  { _tag: "TextEdited", text: "ef" },
  { state: { text: "", hits: [] }, props: { placeholder: "search" }, hooks: {} },
);

Next.state(next); // => { text: "ef", hits: [] }
Next.command(next); // => { _tag: "Batch", commands: [{ _tag: "Cancel", … }, { _tag: "Keyed", … }] }
```

Who interprets it decides what happens. `run` forks it against the layer it was given. The React store forks it into the mount's scope and books its fiber. A test can read it and assert on the shape without running anything.

## One leaf

`Command.effect` is the only leaf of the ADT. The other constructors combine, name or interrupt.

```ts continue
type Hits = { readonly _tag: "HitsArrived"; readonly hits: ReadonlyArray<string> };

const load = Command.effect<Hits, Search>((dispatch) =>
  Effect.flatMap(Search, (search) => search.query("effect")).pipe(
    Effect.flatMap((hits) => dispatch({ _tag: "HitsArrived", hits })),
  ),
);
```

Every leaf takes `(dispatch) => Effect<unknown, never, R>` and emits by calling `dispatch`, zero times, once, or forever. A command that emits nothing ignores the parameter, so there is no separate variant for work with no result.

Inside a handler's return, `dispatch` is typed from the contextual return type of the reducer. A command written standalone has no such context, so it names its own vocabulary and services.

A long-lived source is the same leaf, dispatching many times.

```ts continue
import { Stream } from "effect";

declare const hitStream: Stream.Stream<ReadonlyArray<string>>;

const subscribe = Command.effect<Hits>((dispatch) =>
  Stream.runForEach(hitStream, (batch) => dispatch({ _tag: "HitsArrived", hits: batch })),
);
```

`Command.stream` existed and was removed. It described one Effect shape as a second ADT node, and the whole `Stream` vocabulary is available one call earlier inside the leaf. `Command.ignore`, `Command.queue` and the `Policy` type went with it, for the reason below.

## Concurrency belongs to Effect

Debounce, throttle, take-latest and run-at-most-N are Effect combinators. The `Effect.sleep("300 millis")` above is the debounce, written where the work is.

```ts continue
const debounced = <A, R>(work: Effect.Effect<A, never, R>): Effect.Effect<A, never, R> =>
  Effect.sleep("300 millis").pipe(Effect.flatMap(() => work));
```

A policy vocabulary written as data can only be a smaller copy of that. The runtime owns the one thing a handler cannot write for itself: naming a running fiber so a different action's handler can interrupt it. That is `Command.keyed` and `Command.cancel`, and it is the whole supervisor. See [groups and cancellation](/docs/explanation/groups-and-cancellation).

## A command can be lazy

A handler that writes state inline often needs that same state in the command. The lazy form hands the thunk the state it sits beside.

```ts continue
const lazily = SearchBox.reducer({
  TextEdited: ({ text }, { state }) => [
    { ...state, text },
    (current) =>
      Command.effect((dispatch) =>
        Effect.flatMap(Search, (search) => search.query(current.text)).pipe(
          Effect.flatMap((found) => dispatch({ _tag: "HitsArrived" as const, hits: found })),
        ),
      ),
  ],
  HitsArrived: ({ hits }, { state }) => ({ ...state, hits }),
});
```

`Next.command` is the single resolution point. It calls the thunk once, with the tuple's own state, and returns what it returned.

```ts continue
const lazyNext: Next<{ text: string }, never> = [{ text: "ef" }, () => Command.none];
Next.command(lazyNext); // => { _tag: "None" }
```

`reduce`'s `Unmounted` branch, `run`, the store's fold and its teardown all read through that accessor, so a lazy command reaches the interpreter already resolved. A `Lazy` ADT variant would put a second resolution site in every consumer, and devtools would report a function where a command belongs.

## Commands cannot fail

The leaf's error channel is `never`. An effect with an open error channel does not compile.

```ts continue
// @ts-expect-error a command's error channel is `never`
const failing = Command.effect(() => Effect.fail("boom"));
```

A failure a feature cares about is part of its model, so it belongs in an action payload or in a [task](/docs/reference/tasks) field. `Effect.catchCause` inside the leaf turns a typed failure into a dispatch, which is where the feature can render it.

What remains is a defect: a bug in the effect, or a feature layer that fails to build. Both reach the `Error` lifecycle handler.

```ts continue
const recovering = SearchBox.reducer({
  TextEdited: ({ text }, { state }) => ({ ...state, text }),
  HitsArrived: ({ hits }, { state }) => ({ ...state, hits }),
  Error: ({ error }, { state }) => ({ ...state, hits: [String(error)] }),
});
```

With no `Error` handler the defect is rethrown during render, which is the only place a React error boundary can catch it. Interruption is how commands normally end, so a cancelled or unmounted fiber is never reported as a defect.

One consequence to plan for: `run` counts in-flight work to decide quiescence, so a command that never completes keeps it from resolving. Test a subscription by cancelling it, or by folding through `reduce`. Constructor signatures are in [commands](/docs/reference/commands).
