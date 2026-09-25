---
title: Commands
description: Every Command constructor, the two dispatch forms, groups, Pipeable, and the contextual typing rule.
order: 4
---

# Commands

A command is data a reducer returns beside the next state. The runtime
interprets it. There is one leaf, `Command.effect`, and five nodes around it.

Every snippet on this page builds on one feature: a search box that queries a
`SearchApi` and cancels the previous query.

```tsx
import { Context, Effect, Layer, Schema } from "effect";
import { Action, Command, define, Next } from "@wych/react";
import type { Command as CommandType, Dispatch, Dispatcher, Group } from "@wych/react";

class SearchApi extends Context.Service<
  SearchApi,
  { readonly query: (text: string) => Effect.Effect<ReadonlyArray<string>> }
>()("SearchApi") {}

const SearchApiLayer = Layer.succeed(SearchApi)({ query: () => Effect.succeed(["one", "two"]) });

const actions = Action({
  Queried: { text: Schema.String },
  Cleared: {},
  Results: { hits: Schema.Array(Schema.String) },
});

const Search = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ text: Schema.String, hits: Schema.Array(Schema.String) }),
  action: actions,
});
```

## `Command.none`

```ts fragment
Command.none: Command<never>
```

The no-op, for a handler where a bare state return reads worse.

```ts continue
const noneReducer = Search.reducer({
  Queried: ({ text }, { draft }) => {
    draft.text = text;
    return [draft, Command.none];
  },
  Cleared: (_payload, { state }) => state,
  Results: ({ hits }, { draft }) => {
    draft.hits = [...hits];
    return draft;
  },
});
```

## `Command.effect`

```ts fragment
Command.effect<A = never, R = never>(
  effect: (dispatch: Dispatcher<A>) => Effect.Effect<unknown, never, R>,
): Command<A, R>

Command.effect<const S extends MemberSource<Channel>, R = never>(
  source: S,
  effect: (dispatch: Dispatcher<MembersOf<S>>) => Effect.Effect<unknown, never, R>,
): Command<MembersOf<S>, R>
```

The only leaf. The effect runs and emits by calling `dispatch`: zero times,
once, or forever. The effect's error channel is `never`, so the effect handles
its own failures before it returns. The second overload takes a `source`
first: a message, a record, a `Task` or an array of those, the same value a
`define` slot takes. The source types `dispatch` and is not stored; see
[Contextual typing](#contextual-typing).

```ts continue
const effectReducer = Search.reducer({
  Queried: ({ text }, { draft }) => {
    draft.text = text;
    return [
      draft,
      Command.effect((dispatch) =>
        Effect.gen(function* () {
          const api = yield* SearchApi;
          const hits = yield* api.query(text);
          yield* dispatch(actions.Results, { hits });
        }),
      ),
    ];
  },
  Cleared: (_payload, { draft }) => {
    draft.hits = [];
    return draft;
  },
  Results: ({ hits }, { draft }) => {
    draft.hits = [...hits];
    return draft;
  },
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

A source that outlives one fold, such as a websocket or a stream of ticks, is
a subscription, not a command; see
[Subscriptions](/docs/reference/subscriptions).

## `Dispatcher` and `Dispatch`

```ts fragment
interface Dispatcher<A> {
  <M extends MessageOf<A>>(message: M, ...payload: PayloadArgs<M>): Effect.Effect<void>;
  (action: A): Effect.Effect<void>;
}

interface Dispatch<A> {
  <M extends MessageOf<A>>(message: M, ...payload: PayloadArgs<M>): void;
  (action: A): void;
}

type MessageOf<A> = AnyMessage<Channel> & { readonly Type: A }; // a schema whose values A admits
type PayloadOf<M> = Omit<M["~type.make.in"], "_tag">; // what M.make takes
type PayloadArgs<M> = {} extends PayloadOf<M> ? [payload?: PayloadOf<M>] : [payload: PayloadOf<M>];
```

`Dispatcher` is what a command's effect receives. It returns an `Effect`, so it
composes with the effect that calls it. `Dispatch` is what `render` and
`useFeature` receive. It returns `void` and is called from an event handler.

Both take a message schema and its payload, or a built message.
`dispatch(actions.Results, { hits })` is `dispatch(actions.Results.make({ hits }))`.
The payload argument is optional when every field of the message is optional,
so `dispatch(actions.Cleared)` needs none.

```ts continue
const search = Search.create({
  initialState: Search.initialState(() => ({ text: "", hits: [] })),
  reducer: Search.reducer({
    Queried: ({ text }, { draft }) => {
      draft.text = text;
      return [
        draft,
        Command.effect((dispatch) =>
          Effect.gen(function* () {
            const api = yield* SearchApi;
            const hits = yield* api.query(text);
            yield* dispatch(actions.Results, { hits });
            if (hits.length === 0) yield* dispatch(actions.Cleared);
          }),
        ),
      ];
    },
    Cleared: (_payload, { draft }) => {
      draft.hits = [];
      return draft;
    },
    Results: ({ hits }, { draft }) => {
      draft.hits = [...hits];
      return draft;
    },
  }),
  render: Search.render(() => null),
});

const queried = await Effect.runPromise(
  search.run([actions.Queried.make({ text: "cats" })], {
    props: {},
    hooks: {},
    layer: SearchApiLayer,
  }),
);

console.log(queried.state);
// => { text: "cats", hits: ["one", "two"] }
console.log(queried.emitted);
// => [{ _tag: "Results", hits: ["one", "two"] }]
```

`make` validates the payload. A payload the schema rejects is a defect of the
command that sent it: `Error` folds when the feature handles it, and `run`
reports it in `defects`.

```ts continue
const malformed = Search.create({
  initialState: Search.initialState(() => ({ text: "", hits: [] })),
  reducer: Search.reducer({
    Queried: (_payload, { state }) => [
      state,
      Command.effect((dispatch) => dispatch(actions.Results, { hits: "one" as never })),
    ],
    Cleared: (_payload, { state }) => state,
    Results: ({ hits }, { draft }) => {
      draft.hits = [...hits];
      return draft;
    },
  }),
  render: Search.render(() => null),
});

const rejected = await Effect.runPromise(
  malformed.run([actions.Queried.make({ text: "cats" })], {
    props: {},
    hooks: {},
    layer: SearchApiLayer,
  }),
);

console.log(rejected.state);
// => { text: "", hits: [] }
console.log(rejected.defects.map(({ from, handled }) => ({ from, handled })));
// => [{ from: "Queried", handled: false }]
```

`Dispatch` takes the same two forms from the view. A rejected payload there
throws out of the event handler; see [Runtime](/docs/reference/runtime#dispatch).

```tsx continue
const dispatchRender = Search.render(({ state, dispatch }) => {
  const send: Dispatch<{ readonly _tag: "Cleared" }> = dispatch;
  return <button onClick={() => send(actions.Cleared)}>Clear {state.text}</button>;
});
```

## `Command.keyed`

```ts fragment
Command.keyed(key: string): <A, R>(command: Command<A, R>) => Command<A, R>
Command.keyed<A, R>(key: string, command: Command<A, R>): Command<A, R>
```

`keyed` names the group a command's fibers book under. It does nothing else.
It interrupts nothing, defers nothing, and serialises nothing.

```ts continue
const keyedReducer = Search.reducer({
  Queried: ({ text }, { draft }) => {
    draft.text = text;
    return [
      draft,
      Command.keyed(
        "query",
        Command.effect((dispatch) =>
          Effect.gen(function* () {
            const api = yield* SearchApi;
            const hits = yield* api.query(text);
            yield* dispatch(actions.Results, { hits });
          }),
        ),
      ),
    ];
  },
  Cleared: (_payload, { draft }) => {
    draft.hits = [];
    return [draft, Command.cancel("query")];
  },
  Results: ({ hits }, { draft }) => {
    draft.hits = [...hits];
    return draft;
  },
});
```

Nesting resolves outermost-first: an inner `keyed` under an outer one changes
nothing.

## `Command.batch`

```ts fragment
Command.batch<A, R>(...commands: ReadonlyArray<Command<A, R>>): Command<A, R>
```

Members are interpreted in order under one context. `batch` is the place for a
`cancel` that runs before the command that replaces its work. Compose effects
with `Effect.all` inside a single leaf.

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
  Queried: ({ text }, { draft }) => {
    draft.text = text;
    return [draft, Command.none];
  },
  Cleared: (_payload, { draft }) => {
    draft.hits = [];
    return [draft, Command.cancel("query")];
  },
  Results: ({ hits }, { draft }) => {
    draft.hits = [...hits];
    return draft;
  },
});
```

`Command.cancel("Queried")` reaches only the unkeyed fibers of the `Queried`
tag. Keyed work is reached by its key.

## `Command.restart`

```ts fragment
Command.restart(name: Group): <A, R>(command: Command<A, R>) => Command<A, R>
Command.restart<A, R>(name: Group, command: Command<A, R>): Command<A, R>
```

`restart` is take-latest in one call. `restart(name, command)` is exactly
`batch(cancel(name), keyed(name, command))`. The interpreter and devtools see
that batch.

```ts continue
const takeLatest = Search.reducer({
  Queried: ({ text }, { draft }) => {
    draft.text = text;
    return [
      draft,
      Command.restart(
        "query",
        Command.effect((dispatch) =>
          Effect.gen(function* () {
            yield* Effect.sleep("300 millis");
            const api = yield* SearchApi;
            const hits = yield* api.query(text);
            yield* dispatch(actions.Results, { hits });
          }),
        ),
      ),
    ];
  },
  Cleared: (_payload, { draft }) => {
    draft.hits = [];
    return [draft, Command.cancel("query")];
  },
  Results: ({ hits }, { draft }) => {
    draft.hits = [...hits];
    return draft;
  },
});
```

`restart` returns that `Batch`.

```ts continue
const desugaredRestart = Command.restart("query", Command.none);

console.log(desugaredRestart._tag);
// => "Batch"
```

The debounce above is written with Effect combinators inside the effect. The
runtime owns naming and cancelling. See
[Debounce and take-latest](/docs/how-to/debounce-and-take-latest).

## `Command.output`

```ts fragment
Command.output<M extends AnyMessage<"outbound">>(
  message: M,
  ...payload: PayloadArgs<M>
): Command<M["Type"]>
```

Emits an outbound message, which leaves through its `on<Tag>` prop. The
payload follows the same rule as `dispatch`: required when a field is,
omitted when every field is optional. An internal message as the argument is
a compile error, shown in [Actions and outputs](/docs/reference/actions).

```ts continue
const outputs = Action.output({ Picked: { hit: Schema.String }, Dismissed: {} });

const WithOutput = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ text: Schema.String, hits: Schema.Array(Schema.String) }),
  action: actions,
  output: outputs,
});

const outputReducer = WithOutput.reducer({
  Queried: ({ text }, { draft }) => {
    draft.text = text;
    return [draft, Command.output(outputs.Picked, { hit: text })];
  },
  Cleared: (_payload, { state }) => [state, Command.output(outputs.Dismissed)],
  Results: ({ hits }, { draft }) => {
    draft.hits = [...hits];
    return draft;
  },
});

// @ts-expect-error Picked has a required field
const missingPayload = Command.output(outputs.Picked);
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
  Queried: ({ text }, { draft }) => {
    draft.text = text;
    return [draft, Command.effect(() => Effect.void)];
  },
  // books under "query"
  Cleared: (_payload, { state }) => [
    state,
    Command.keyed(
      "query",
      Command.effect(() => Effect.void),
    ),
  ],
  Results: ({ hits }, { draft }) => {
    draft.hits = [...hits];
    return draft;
  },
});
```

A key equal to an action's tag shares that group with the action's unkeyed
commands. A [task](/docs/reference/tasks) books under `Task/${Name}` to keep
its group apart from every action tag. See
[Groups and cancellation](/docs/explanation/groups-and-cancellation).

## `Pipeable`

Every command is `Pipeable`, so `keyed` and `restart` work in their curried
form.

```ts continue
const piped = Command.effect(() => Effect.void).pipe(Command.keyed("query"));
const pipedRestart = Command.none.pipe(Command.restart("query"));
```

## Contextual typing

`A` is inferred from the contextual type alone. Inside a handler's return,
`dispatch`'s action type comes from the contextual type of that return. A
standalone leaf has no contextual type, so it names the messages it may emit
as its first argument, and `dispatch` accepts those.

```ts continue
const named = Command.effect(actions.Results, (dispatch) =>
  dispatch(actions.Results, { hits: [] }),
);
```

`R` is inferred from the effect in both forms, so a standalone leaf that
needs a service writes nothing more.

```ts continue
const namedWithService = Command.effect(actions.Results, (dispatch) =>
  Effect.gen(function* () {
    const api = yield* SearchApi;
    const hits = yield* api.query("cats");
    yield* dispatch(actions.Results, { hits });
  }),
);
```

A type argument names `A` too, but TypeScript has no partial inference: naming
`A` that way also names `R`, which then must be written out.

```ts continue
const typeArguments = Command.effect<typeof actions.Results.Type, SearchApi>((dispatch) =>
  Effect.gen(function* () {
    const api = yield* SearchApi;
    const hits = yield* api.query("cats");
    yield* dispatch(actions.Results, { hits });
  }),
);
```

A `.pipe` receiver is checked before the contextual type of the `.pipe` call
exists, so a leaf that dispatches loses `A` through `.pipe`. Use the
two-argument form of `keyed` or `restart` there.

```ts continue
const contextual = Search.reducer({
  Queried: ({ text }, { draft }) => {
    draft.text = text;
    return [
      draft,
      // @ts-expect-error dispatch is typed never through .pipe
      Command.effect((dispatch) => dispatch(actions.Results, { hits: [] })).pipe(
        Command.keyed("query"),
      ),
    ];
  },
  Cleared: (_payload, { state }) => state,
  Results: ({ hits }, { draft }) => {
    draft.hits = [...hits];
    return draft;
  },
});
```

`Command.cancel` is `Command<never>`, and `Command` is covariant in `A`, so a
cancel written first in a batch does not pin the batch to `never`.

```ts continue
const cancelFirst = Search.reducer({
  Queried: ({ text }, { draft }) => {
    draft.text = text;
    return [
      draft,
      Command.batch(
        Command.cancel("query"),
        Command.keyed(
          "query",
          Command.effect((dispatch) => dispatch(actions.Results, { hits: [] })),
        ),
      ),
    ];
  },
  Cleared: (_payload, { state }) => state,
  Results: ({ hits }, { draft }) => {
    draft.hits = [...hits];
    return draft;
  },
});
```

The reasoning behind this shape is in
[Commands as data](/docs/explanation/commands-as-data).
