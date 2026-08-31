---
title: Commands
description: The one effect leaf, grouping, batching and cancellation.
order: 4
---

# Commands

A command describes work. The reducer stays pure; the runtime interprets.

## The leaf

`Command.effect` is the **only** leaf:

```ts
Command.effect((dispatch) => Effect.Effect<unknown, never, R>);
```

A command that emits nothing ignores the `dispatch` parameter. There is no
`Command.stream` — a long-lived source is `Stream.runForEach(source, dispatch)`
inside the effect, which keeps the whole `Stream` vocabulary available one call
earlier.

`Command.none` is the `{ _tag: "None" }` no-op. Commands are `Pipeable`, and
piping preserves both the action type and the service requirement `R`.

## Grouping and cancellation

Fibers book under a **group name**. The book is a flat map — no tag level, no
delimiter encoding.

```ts
Command.keyed("search", command); // book under "search"; outermost wins
Command.cancel("search"); // interrupt that group, whatever forked it
```

An **unkeyed** command books under its issuing action's tag, so a bare
`Command.cancel("Bumped")` reaches only the unkeyed fibers of that tag. Work
forked under `keyed(name)` is addressed by `name` alone — which is what makes
cancelling work started from several action tags one line, naming no foreign
tag.

`Command.restart(name, command)` is pure sugar, not a policy. It constructs
exactly:

```ts
Command.batch(Command.cancel(name), Command.keyed(name, command));
```

Both `keyed` and `restart` are curried, and so pipeable.

`Command.batch(...commands)` interprets its members in order under one context.
There are no policies and no supersession rules — with one leaf there is nothing
to decide.

## Emitting an output

```ts
Command.output(Reached, { at: count });
```

Passing an internal message is a compile error. The message leaves through its
`on<Tag>` prop with `_tag` stripped, and never re-enters the reducer. A missing
handler throws to the boundary rather than into this feature's `Error` handler.

## Services

Services a command requests through `R` are satisfied from the root runtime's
layer. `component(feature, { layer })` satisfies the residue — whatever the root
did not provide — so a missing service stays a compile error at the call site.
