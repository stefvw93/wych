---
title: Actions and outputs
description: Action, Action.output, the record form, the two channels, reserved tags, the define slots, dispatch(Message, payload), Emit, MemberOf and TagsOf.
order: 3
---

# Actions and outputs

A message is a `Schema.TaggedStruct` branded with a channel. `Action` builds
one on the internal channel, and `Action.output` builds one on the outbound
channel. `define`'s `action` and `output` slots collect them.

Every snippet on this page builds on one feature: a poll widget that counts
votes and announces the result.

```ts
import { Effect, Layer, Schema } from "effect";
import { Action, Command, define, Task } from "@wych/react";
import type { Emit, MemberOf, TagsOf } from "@wych/react";

const actions = Action({
  Voted: { option: Schema.String, weight: Schema.Number },
  Retracted: { option: Schema.String },
  Closed: {},
});

const Decided = Action.output("Decided", { winner: Schema.String });
const Abandoned = Action.output("Abandoned", { reason: Schema.String });

const Poll = define({
  props: Schema.Struct({ question: Schema.String }),
  state: Schema.Struct({ votes: Schema.Number }),
  action: actions,
  output: [Decided, Abandoned],
});
```

## `Action`

```ts fragment
Action<Tag extends Capitalize<string>, Fields extends Schema.Struct.Fields = {}>(
  tag: Tag,
  fields?: Fields,
): Message<Tag, Fields, "internal">

Action<Defs extends Record<string, Schema.Struct.Fields>>(
  defs: Defs & ValidTags<Defs>,
): Messages<Defs, "internal">
```

An action reaches the reducer. `_tag` is part of the schema, so a message is
encodable and a union discriminates on it. `make` fills `_tag`.

```ts continue
console.log(Object.keys(actions.Voted.fields).sort());
// => ["_tag", "option", "weight"]
console.log(actions.Voted.make({ option: "tea", weight: 2 }));
// => { _tag: "Voted", option: "tea", weight: 2 }
```

`fields` is optional. A message whose fields are all optional has a `make`
that takes no argument; a message with a required field does not, and `make`
validates what it is given.

```ts continue
const Reopened = Action("Reopened");

console.log(Object.keys(Reopened.fields));
// => ["_tag"]
console.log(Reopened.make());
// => { _tag: "Reopened" }

// @ts-expect-error Voted has a required field
actions.Voted.make();
// throws Error: Schema validation failed
```

A reducer handler receives the payload with `_tag` stripped; the handler key
already names the tag. The tag must be capitalized.

```ts continue
// @ts-expect-error "voted" is not Capitalize<string>
const lowercase = Action("voted");
```

### The record form

`Action({ Tag: fields, ... })` declares several messages at once. It returns
a frozen record with one message per key, in key order, the key as its tag.
`actions` above is one.

```ts continue
console.log(Object.keys(actions));
// => ["Voted", "Retracted", "Closed"]
console.log(Object.isFrozen(actions));
// => true
console.log(actions.Closed.make());
// => { _tag: "Closed" }
```

A lower-case key is a compile error naming the key.

```ts continue
// @ts-expect-error "voted" must be capitalized
const lowercaseKey = Action({ voted: {} });
```

## `Action.output`

```ts fragment
Action.output<Tag extends Capitalize<string>, Fields extends Schema.Struct.Fields = {}>(
  tag: Tag,
  fields?: Fields,
): Message<Tag, Fields, "outbound">

Action.output<Defs extends Record<string, Schema.Struct.Fields>>(
  defs: Defs & ValidTags<Defs>,
): Messages<Defs, "outbound">
```

An output leaves through an `on<Tag>` prop and never reaches the reducer.
`Command.output` takes one; an internal message there is a compile error.

```ts continue
const announce = Command.output(Decided, { winner: "tea" });

// @ts-expect-error Voted is an internal message
const wrongChannel = Command.output(actions.Voted, { option: "tea", weight: 1 });
```

The record form is the same on this channel.

```ts continue
const announcements = Action.output({ Decided: { winner: Schema.String }, Dismissed: {} });

console.log(announcements.Dismissed.make());
// => { _tag: "Dismissed" }
```

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
the runtime. Declaring one on either channel, in either form, is a compile
error.

```ts continue
// @ts-expect-error "Mounted" is a lifecycle tag
const reserved = Action("Mounted");

// @ts-expect-error "Unmounted" is a lifecycle tag
const reservedOutput = Action.output("Unmounted");

// @ts-expect-error "Error" is a reserved lifecycle tag
const reservedKey = Action({ Error: { reason: Schema.String } });
```

Their payloads and firing order are in [Lifecycle](/docs/reference/lifecycle).

## The `define` slots

```ts fragment
type MemberLeaf<Ch extends Channel> =
  | AnyMessage<Ch> // Action("Tag", fields)
  | MemberCarrier<...> // a Task operation
  | { readonly [tag: string]: AnyMessage<Ch> }; // Action({ ... })

type MemberSource<Ch extends Channel> =
  | MemberLeaf<Ch>
  | ReadonlyArray<MemberLeaf<Ch> | ReadonlyArray<MemberLeaf<Ch>>>;

define({ action: MemberSource<"internal">, output?: MemberSource<"outbound"> })
```

`action` and `output` each take a message, a record of messages, a
[task](/docs/reference/tasks) operation, or an array of those, one array nested
inside another at most. `define` flattens the source, so a tag from any depth
is a handler key of the reducer.

```ts continue
const tally = Task("Tally", { success: Schema.Number });

const Nested = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ votes: Schema.Number, total: tally.schema }),
  action: [actions, [Reopened, tally]],
  output: Decided,
});
```

The slot is the channel check. `action` takes internal members only and
`output` outbound ones, so an outbound message, a `Task.output` operation or a
mixed array in `action` is a compile error, and the reverse in `output`.
`define` repeats the check at runtime and throws, for a source that got past
the types through a cast.

```ts continue
define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  // @ts-expect-error Decided is outbound and cannot be declared in "action"
  action: [actions, Decided],
});
// throws TypeError: define: "Decided" is outbound and cannot be declared in "action"

define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  action: actions,
  // @ts-expect-error Reopened is internal and cannot be declared in "output"
  output: Reopened,
});
// throws TypeError: define: "Reopened" is internal and cannot be declared in "output"
```

Two members with one tag unify at the type level into one union payload, so
the types do not catch a duplicate. `define` does: a tag declared twice across
both slots throws.

```ts continue
define({
  props: Schema.Struct({}),
  state: Schema.Struct({}),
  action: [actions, Action("Voted")],
});
// throws TypeError: define: tag "Voted" is declared twice
```

Two more rules bind the channels to `define`: an output tag equal to an action
tag is a compile error, and a prop named `on<OutputTag>` is a compile error.
Both are shown in [Features](/docs/reference/features#define).

## `dispatch(Message, payload)`

```ts fragment
dispatch(message, payload); // payload: the message's fields without _tag
dispatch(message); // when every field is optional
dispatch(message.make(payload)); // a built message
```

Every `dispatch` takes a message schema and its payload, or a built message:
`render`'s, `useFeature().dispatch`, and the `Dispatcher` a `Command.effect`
or `Subscription.effect` leaf is handed. `dispatch(Decided, { winner })` is
`dispatch(Decided.make({ winner }))`. The payload argument is optional when
every field is optional.

```ts continue
const poll = Poll.create({
  initialState: Poll.initialState(() => ({ votes: 0 })),
  reducer: Poll.reducer({
    Voted: ({ weight }, { draft }) => {
      draft.votes += weight;
      return draft;
    },
    Retracted: (_payload, { draft }) => {
      draft.votes -= 1;
      return draft;
    },
    Closed: (_payload, { state }) => [
      state,
      Command.effect((dispatch) =>
        state.votes > 0
          ? dispatch(Decided, { winner: "tea" })
          : dispatch(Abandoned, { reason: "no votes" }),
      ),
    ],
  }),
  render: Poll.render(() => null),
});

const decided = await Effect.runPromise(
  poll.run([actions.Voted.make({ option: "tea", weight: 2 }), actions.Closed.make()], {
    props: { question: "Tea or coffee?" },
    hooks: {},
    layer: Layer.empty,
  }),
);

console.log(decided.state);
// => { votes: 2 }
console.log(decided.outputs);
// => [{ _tag: "Decided", winner: "tea" }]
```

`feature.run` seeds and `feature.reduce` take built messages, as above.
`make` validates, so a payload the schema rejects is a defect of the command
or subscription that sent it, and throws out of the event handler that called
`render`'s `dispatch`. The `Dispatcher` types and the defect are in
[Commands](/docs/reference/commands#dispatcher-and-dispatch); the view's
`dispatch` is in [Runtime](/docs/reference/runtime#dispatch).

## `Emit`, `MemberOf` and `TagsOf`

```ts fragment
type MemberOf<S> = ...; // the message values a source declares, as a union
type TagsOf<S> = MembersOf<S>["_tag"]; // their tags
type Emit<A extends Tagged, O extends Tagged> = A | O;
```

`MemberOf` and `TagsOf` read a member source: one message, a record, a task
or an array of those, the same shapes a slot takes. `Emit` is what a command
may emit and what `render`'s `dispatch` accepts: the declared actions and the
declared outputs.

```ts continue
type PollAction = MemberOf<typeof actions>;
type PollTag = TagsOf<typeof actions>;
type PollMessage = Emit<PollAction, MemberOf<[typeof Decided, typeof Abandoned]>>;

const retracted: PollAction = { _tag: "Retracted", option: "tea" };
const tag: PollTag = "Closed";
const announced: PollMessage = { _tag: "Decided", winner: "tea" };

// @ts-expect-error "Decided" is an output tag
const outputTag: PollTag = "Decided";
```

A feature with no `output` has `never` on the outbound side, so `Emit` is the
actions alone and `OutputProps` is `{}`.

```ts continue
type LeafMessage = Emit<PollAction, never>;

// @ts-expect-error a leaf feature emits no output
const notEmitted: LeafMessage = { _tag: "Decided", winner: "tea" };
```

For the reasoning behind the two channels, see
[Actions and outputs](/docs/explanation/actions-and-outputs).
