---
title: Commands
description: Every Command constructor, the dispatcher, groups, Pipeable, and the contextual typing rule.
order: 4
---

# Commands

A command is data a reducer returns beside the next state. The runtime
interprets it. There is one leaf, `Command.effect`, and five nodes around it.

Every snippet on this page builds on one feature: a search box that queries a
`SearchApi` and cancels the previous query.

```tsx
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Action, Command, define, Next } from "@wych/react";
import type { Command as CommandType, Dispatch, Dispatcher, Group } from "@wych/react";

class SearchApi extends Context.Service<
  SearchApi,
  { readonly query: (text: string) => Effect.Effect<ReadonlyArray<string>> }
>()("SearchApi") {}

const SearchApiLayer = Layer.succeed(SearchApi)({ query: () => Effect.succeed(["one", "two"]) });

const Queried = Action("Queried", { text: Schema.String });
const Cleared = Action("Cleared", {});
const Results = Action("Results", { hits: Schema.Array(Schema.String) });

const Search = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ text: Schema.String, hits: Schema.Array(Schema.String) }),
  action: Action.of([Queried, Cleared, Results]),
});
```

## `Command.none`

```ts fragment
Command.none: Command<never>
```

The no-op, for a handler where a bare state return reads worse.

```ts continue
const noneReducer = Search.reducer({
  Queried: ({ text }, { state }) => [{ ...state, text }, Command.none],
  Cleared: (_payload, { state }) => state,
  Results: ({ hits }, { state }) => ({ ...state, hits }),
});
```

## `Command.effect`

```ts fragment
Command.effect<A, R>(
  effect: (dispatch: Dispatcher<A>) => Effect.Effect<unknown, never, R>,
): Command<A, R>
```

The only leaf. It runs for effects and emits by calling `dispatch`, zero times,
once, or forever. The effect's error channel is `never`: a command that can
fail says what it does about the failure inside the effect.

```ts continue
const effectReducer = Search.reducer({
  Queried: ({ text }, { state }) => [
    { ...state, text },
    Command.effect((dispatch) =>
      Effect.flatMap(SearchApi, (api) => api.query(text)).pipe(
        Effect.flatMap((hits) => dispatch({ _tag: "Results", hits })),
      ),
    ),
  ],
  Cleared: (_payload, { state }) => ({ ...state, hits: [] }),
  Results: ({ hits }, { state }) => ({ ...state, hits }),
});
```

A command that emits nothing ignores the parameter. `R` travels out of the
effect, so the services a feature needs are read off its reducer's return
types.

```ts continue
// @ts-expect-error the effect's error channel must be never
const failing = Command.effect(() => Effect.fail("boom"));

// @ts-expect-error the leaf takes a callback that returns an effect
const notACallback = Command.effect(Effect.void);
```

A long-lived source is a leaf that never settles:

```ts continue
const subscription = Command.effect<{
  readonly _tag: "Results";
  readonly hits: ReadonlyArray<string>;
}>((dispatch) =>
  Stream.runForEach(Stream.make(["one"], ["two"]), (hits) => dispatch({ _tag: "Results", hits })),
);
```

## `Dispatcher` and `Dispatch`

```ts fragment
type Dispatcher<A> = (action: A) => Effect.Effect<void>;
type Dispatch<A> = (action: A) => void;
```

`Dispatcher` is what a command's effect receives. It returns an `Effect`, so it
composes with the effect that calls it. `Dispatch` is what `render` and
`useFeature` receive. It returns `void` and is called from an event handler.

```tsx continue
const dispatchRender = Search.render(({ state, dispatch }) => {
  const send: Dispatch<{ readonly _tag: "Cleared" }> = dispatch;
  return <button onClick={() => send({ _tag: "Cleared" })}>Clear {state.text}</button>;
});
```

## `Command.keyed`

```ts fragment
Command.keyed(key: string): <A, R>(command: Command<A, R>) => Command<A, R>
Command.keyed<A, R>(key: string, command: Command<A, R>): Command<A, R>
```

`keyed` names the group a command's fibers book under. It does nothing else: no
interrupting, no deferring, no serialising.

```ts continue
const keyedReducer = Search.reducer({
  Queried: ({ text }, { state }) => [
    { ...state, text },
    Command.keyed(
      "query",
      Command.effect((dispatch) =>
        Effect.flatMap(SearchApi, (api) => api.query(text)).pipe(
          Effect.flatMap((hits) => dispatch({ _tag: "Results", hits })),
        ),
      ),
    ),
  ],
  Cleared: (_payload, { state }) => [{ ...state, hits: [] }, Command.cancel("query")],
  Results: ({ hits }, { state }) => ({ ...state, hits }),
});
```

Nesting resolves outermost-first: an inner `keyed` under an outer one changes
nothing.

## `Command.batch`

```ts fragment
Command.batch<A, R>(...commands: ReadonlyArray<Command<A, R>>): Command<A, R>
```

Members are interpreted in order under one context. The one thing `batch` can
do that `Effect.all` cannot is put a `cancel` before the command that replaces
it. Compose effects with `Effect.all` inside a single leaf.

```ts continue
const replace = Command.batch(
  Command.cancel("query"),
  Command.keyed(
    "query",
    Command.effect(() => Effect.void),
  ),
);
```

## `Command.cancel`

```ts fragment
Command.cancel<A = never>(target: Group): Command<A, never>
```

`cancel` interrupts every fiber booked under one name. It is a command in its
own right, so one handler can invalidate work another action started.

```ts continue
const cancelReducer = Search.reducer({
  Queried: ({ text }, { state }) => [{ ...state, text }, Command.none],
  Cleared: (_payload, { state }) => [{ ...state, hits: [] }, Command.cancel("query")],
  Results: ({ hits }, { state }) => ({ ...state, hits }),
});
```

`Command.cancel("Queried")` reaches only the unkeyed fibers of the `Queried`
tag. Keyed work answers to its own name.

## `Command.restart`

```ts fragment
Command.restart(name: Group): <A, R>(command: Command<A, R>) => Command<A, R>
Command.restart<A, R>(name: Group, command: Command<A, R>): Command<A, R>
```

Take-latest as one word. `restart(name, command)` is exactly
`batch(cancel(name), keyed(name, command))`. The interpreter and devtools see
the desugared batch.

```ts continue
const takeLatest = Search.reducer({
  Queried: ({ text }, { state }) => [
    { ...state, text },
    Command.restart(
      "query",
      Command.effect((dispatch) =>
        Effect.sleep("300 millis").pipe(
          Effect.andThen(Effect.flatMap(SearchApi, (api) => api.query(text))),
          Effect.flatMap((hits) => dispatch({ _tag: "Results", hits })),
        ),
      ),
    ),
  ],
  Cleared: (_payload, { state }) => [{ ...state, hits: [] }, Command.cancel("query")],
  Results: ({ hits }, { state }) => ({ ...state, hits }),
});
```

The desugaring is visible on the value: `restart` returns a `Batch`.

```ts continue
const desugaredRestart = Command.restart("query", Command.none);

console.log(desugaredRestart._tag);
// => "Batch"
```

The debounce above is written with Effect combinators. Concurrency policy
lives inside the effect. The runtime owns naming and cancelling. See
[Debounce and take-latest](/docs/how-to/debounce-and-take-latest).

## `Command.output`

```ts fragment
Command.output<Tag, Fields>(
  message: Message<Tag, Fields, "outbound">,
  payload: Omit<Schema.Struct<Fields>["Type"], "_tag">,
): Command<{ readonly _tag: Tag } & ...>
```

Emits an outbound message, which leaves through its `on<Tag>` prop. Passing an
internal message is a compile error, shown in
[Actions and outputs](/docs/reference/actions).

```ts continue
const Picked = Action.output("Picked", { hit: Schema.String });

const WithOutput = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ text: Schema.String, hits: Schema.Array(Schema.String) }),
  action: Action.of([Queried, Cleared, Results]),
  output: Action.of([Picked]),
});

const outputReducer = WithOutput.reducer({
  Queried: ({ text }, { state }) => [{ ...state, text }, Command.output(Picked, { hit: text })],
  Cleared: (_payload, { state }) => state,
  Results: ({ hits }, { state }) => ({ ...state, hits }),
});
```

## `Group`

```ts fragment
type Group = string;
```

One flat namespace per mount. The booking address of a command is `key ?? tag`:
a `keyed` command books under its key, and an unkeyed command books under its
issuing action's tag.

```ts continue
const addresses: ReadonlyArray<Group> = ["query", "Queried"];

const grouped = Search.reducer({
  // books under "Queried", the issuing action's tag
  Queried: ({ text }, { state }) => [{ ...state, text }, Command.effect(() => Effect.void)],
  // books under "query"
  Cleared: (_payload, { state }) => [
    state,
    Command.keyed(
      "query",
      Command.effect(() => Effect.void),
    ),
  ],
  Results: ({ hits }, { state }) => ({ ...state, hits }),
});
```

A key equal to some action's tag is deliberate sharing: one namespace means
one meaning per name. A [task](/docs/reference/tasks) books under
`Task/${Name}` for that reason. See
[Groups and cancellation](/docs/explanation/groups-and-cancellation).

## `Pipeable`

Every command is `Pipeable`, so `keyed` and `restart` work in their curried
form.

```ts continue
const piped = Command.effect(() => Effect.void).pipe(Command.keyed("query"));
const pipedRestart = Command.none.pipe(Command.restart("query"));
```

## Contextual typing

`A` has no inference site of its own. Inside a handler's return, `dispatch`'s
action type comes from the contextual type of that return. Written standalone,
`A` falls back to `never`, so name it with a type argument.

```ts continue
const named = Command.effect<{ readonly _tag: "Results"; readonly hits: ReadonlyArray<string> }>(
  (dispatch) => dispatch({ _tag: "Results", hits: [] }),
);
```

`R` defaults to `never` on the same terms, so a standalone leaf that needs a
service names both type arguments.

```ts continue
const namedWithService = Command.effect<
  { readonly _tag: "Results"; readonly hits: ReadonlyArray<string> },
  SearchApi
>((dispatch) =>
  Effect.flatMap(SearchApi, (api) => api.query("cats")).pipe(
    Effect.flatMap((hits) => dispatch({ _tag: "Results", hits })),
  ),
);
```

A `.pipe` receiver is checked before the contextual type of the `.pipe` call
exists, so a leaf that dispatches loses `A` through `.pipe`. Use the
two-argument form of `keyed` or `restart` there.

```ts continue
const contextual = Search.reducer({
  Queried: ({ text }, { state }) => [
    { ...state, text },
    // @ts-expect-error dispatch is typed never through .pipe
    Command.effect((dispatch) => dispatch({ _tag: "Results", hits: [] })).pipe(
      Command.keyed("query"),
    ),
  ],
  Cleared: (_payload, { state }) => state,
  Results: ({ hits }, { state }) => ({ ...state, hits }),
});
```

`Command.cancel` is `Command<never>`, and `Command` is covariant in `A`, so a
cancel written first in a batch does not pin the batch to `never`.

```ts continue
const cancelFirst = Search.reducer({
  Queried: ({ text }, { state }) => [
    { ...state, text },
    Command.batch(
      Command.cancel("query"),
      Command.keyed(
        "query",
        Command.effect((dispatch) => dispatch({ _tag: "Results", hits: [] })),
      ),
    ),
  ],
  Cleared: (_payload, { state }) => state,
  Results: ({ hits }, { state }) => ({ ...state, hits }),
});
```

## What does not exist

`Command.stream`, `Command.ignore`, `Command.queue` and a `Policy` vocabulary
were removed. The constructor set is exactly `none`, `effect`, `keyed`,
`batch`, `cancel`, `restart` and `output`.

```ts continue
const constructors: ReadonlyArray<keyof typeof Command> = [
  "none",
  "effect",
  "keyed",
  "batch",
  "cancel",
  "restart",
  "output",
];
```

Why the model is shaped this way: [Commands as
data](/docs/explanation/commands-as-data).
