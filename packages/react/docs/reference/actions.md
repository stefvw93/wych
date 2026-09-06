---
title: Actions and outputs
description: Action, Action.output, Action.of, the two channels, reserved tags, Emit and NoOutputs.
order: 3
---

# Actions and outputs

A message is a `Schema.TaggedStruct` branded with a channel. `Action` builds
one on the internal channel, and `Action.output` builds one on the outbound
channel. `Action.of` collects members into a vocabulary.

Every snippet on this page builds on one vocabulary: the messages of a poll
widget that counts votes and announces the result.

```ts
import { Schema } from "effect";
import { Action, Command, define } from "@wych/react";
import type { Emit, NoOutputs } from "@wych/react";

const Voted = Action("Voted", { option: Schema.String, weight: Schema.Number });
const Retracted = Action("Retracted", { option: Schema.String });
const Closed = Action("Closed", {});

const Decided = Action.output("Decided", { winner: Schema.String });
const Abandoned = Action.output("Abandoned", { reason: Schema.String });
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
console.log(Object.keys(Voted.fields).sort());
// => ["_tag", "option", "weight"]
console.log(Voted.make({ option: "tea", weight: 2 }));
// => { _tag: "Voted", option: "tea", weight: 2 }
```

`make` fills `_tag`. `dispatch` takes the whole tagged message, and a reducer
handler receives the payload with `_tag` stripped.

The tag must be capitalized.

```ts continue
// @ts-expect-error "voted" is not Capitalize<string>
const lowercase = Action("voted", {});
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
const announce = Command.output(Decided, { winner: "tea" });

// @ts-expect-error Voted is an internal message
const wrongChannel = Command.output(Voted, { option: "tea", weight: 1 });
```

`Action.output` is a plain function, so `Action.output.of` does not exist.
Build an outbound vocabulary with `Action.of`, which reads the channel off its
members.

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
const PollActions = Action.of([Voted, Retracted, Closed]);
const PollOutputs = Action.of([Decided, Abandoned]);

// @ts-expect-error the member list straddles both channels
const mixed = Action.of([Voted, Decided]);
```

### `cases`

A record from tag to member, each with its own `make`.

```ts continue
console.log(Object.keys(PollActions.cases));
// => ["Voted", "Retracted", "Closed"]
console.log(PollActions.cases.Retracted.make({ option: "tea" }));
// => { _tag: "Retracted", option: "tea" }
```

The keys of `cases` are the handler keys the feature's reducer must declare.

### `guards`

One type guard per tag.

```ts continue
const message = PollActions.cases.Voted.make({ option: "tea", weight: 2 });

console.log(PollActions.guards.Voted(message));
// => true
console.log(PollActions.guards.Retracted(message));
// => false
```

### `match`

```ts continue
const describe = PollActions.match(message, {
  Voted: (voted) => `+${voted.weight} ${voted.option}`,
  Retracted: (retracted) => `-${retracted.option}`,
  Closed: () => "closed",
});

console.log(describe);
// => "+2 tea"
```

`match` is exhaustive: every case is required. Each case receives the whole
member, `_tag` included. A reducer handler receives the payload, with `_tag`
stripped.

### Nesting

A vocabulary is itself a member. `of` flattens the inner `cases` into the outer
union, so a tag from an inner vocabulary is constructible and discriminable at
the outer one.

```ts continue
const AsyncActions = Action.of([
  Action("Started", {}),
  Action("Failed", { reason: Schema.String }),
]);
const AllActions = Action.of([AsyncActions, Closed]);

console.log(Object.keys(AllActions.cases).sort());
// => ["Closed", "Failed", "Started"]
console.log(AllActions.cases.Failed.make({ reason: "network" }));
// => { _tag: "Failed", reason: "network" }
```

This is how a [task](/docs/reference/tasks) contributes its two generated
actions: `Action.of([Closed, ...tally.actions])`.

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
type PollMessage = Emit<typeof PollActions, typeof PollOutputs>;
type LeafMessage = Emit<typeof PollActions, NoOutputs>;

const Poll = define({
  props: Schema.Struct({ question: Schema.String }),
  state: Schema.Struct({ votes: Schema.Number }),
  action: PollActions,
  output: PollOutputs,
});

const poll = Poll.create({
  initialState: Poll.initialState(() => ({ votes: 0 })),
  reducer: Poll.reducer({
    Voted: ({ weight }, { state }) => ({ votes: state.votes + weight }),
    Retracted: (_payload, { state }) => ({ votes: state.votes - 1 }),
    Closed: (_payload, { state }) => [state, Command.output(Decided, { winner: "tea" })],
  }),
  render: Poll.render(() => null),
});
```

Two more rules bind the channels to `define`: an output tag equal to an action
tag is a compile error, and a prop named `on<OutputTag>` is a compile error.
Both are shown in [Features](/docs/reference/features). For the reasoning, see
[Actions and outputs](/docs/explanation/actions-and-outputs).
