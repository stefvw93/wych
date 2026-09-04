---
title: Commands as data
description: Why a handler describes work instead of doing it, and what a description buys.
order: 3
---

# Commands as data

A file upload in React is an `async` function inside an event handler. It
awaits, it calls `setProgress` in a loop, and it hopes the component is
still there when it returns. Cancelling it means an `AbortController` in a
ref. Testing it means a mounted component and a mocked network.

In Wych a handler returns the upload as a value. Nothing in the handler runs.

```ts
import { Action, Command, define, Next } from "@wych/react";
import { Cause, Context, Effect, Layer, Schema, Stream } from "effect";

class Uploads extends Context.Service<
  Uploads,
  { readonly upload: (name: string) => Stream.Stream<number, Error> }
>()("Uploads") {}

const Picked = Action("Picked", { name: Schema.String });
const Progressed = Action("Progressed", { percent: Schema.Number });
const Finished = Action("Finished", {});
const Failed = Action("Failed", { message: Schema.String });
const Cancelled = Action("Cancelled", {});

const Uploader = define({
  props: Schema.Struct({}),
  state: Schema.Struct({
    name: Schema.String,
    percent: Schema.Number,
    status: Schema.String,
  }),
  action: Action.of([Picked, Progressed, Finished, Failed, Cancelled]),
});
```

The reducer stays a pure function of `(payload, snapshot)`. That is what
makes `feature.reduce` callable in a test, `feature.run` able to fold a
sequence, and a devtools transition a pair of plain values.

```ts continue
const uploader = Uploader.create({
  initialState: () => ({ name: "", percent: 0, status: "idle" }),
  reducer: {
    Picked: ({ name }, { state }) => [
      { ...state, name, percent: 0, status: "uploading" },
      Command.restart(
        "upload",
        Command.effect((dispatch) =>
          Effect.flatMap(Uploads, (uploads) =>
            Stream.runForEach(uploads.upload(name), (percent) =>
              dispatch(Progressed.make({ percent })),
            ),
          ).pipe(
            Effect.flatMap(() => dispatch(Finished.make({}))),
            Effect.catchCause((cause) =>
              dispatch(Failed.make({ message: String(Cause.squash(cause)) })),
            ),
          ),
        ),
      ),
    ],
    Progressed: ({ percent }, { state }) => ({ ...state, percent }),
    Finished: (_payload, { state }) => ({ ...state, percent: 100, status: "done" }),
    Failed: ({ message }, { state }) => ({ ...state, status: message }),
    Cancelled: (_payload, { state }) => [
      { ...state, status: "cancelled" },
      Command.cancel("upload"),
    ],
  },
  render: () => null,
});
```

The command the handler returned is readable before anything runs.

```ts continue
const picked = uploader.reduce(Picked.make({ name: "photo.jpg" }), {
  state: { name: "", percent: 0, status: "idle" },
  props: {},
  hooks: {},
});

console.log(Next.state(picked));
// => { name: "photo.jpg", percent: 0, status: "uploading" }
console.log(Next.command(picked)?._tag);
// => "Batch"
```

Who interprets it decides what happens. `run` forks it against the layer it
was given. The React store forks it into the mount's scope and books its
fiber. A test can read it and assert on the shape without running anything,
which the `async` handler could never offer.

```ts continue
const threeSteps = Layer.succeed(Uploads)({
  upload: () => Stream.make(25, 50, 100),
});

const done = await Effect.runPromise(
  uploader.run([Picked.make({ name: "photo.jpg" })], {
    props: {},
    hooks: {},
    layer: threeSteps,
  }),
);

console.log(done.emitted.map((action) => action._tag));
// => ["Progressed", "Progressed", "Progressed", "Finished"]
console.log(done.state);
// => { name: "photo.jpg", percent: 100, status: "done" }
```

## One leaf

`Command.effect` is the only leaf. It takes `(dispatch) => Effect<unknown, never, R>`
and emits by calling `dispatch`: zero times, once, or on every element of a
stream. The other constructors combine, name or interrupt.

An earlier version had `Command.stream` as a second leaf. It described one
Effect shape as its own ADT node, and every `Stream` combinator was already
available one call earlier, inside the effect. It was removed, along with
`Command.ignore`, `Command.queue` and a `Policy` type, for the reason below.

```ts continue
import { Effect as E } from "effect";

const loopback = Command.effect<typeof Progressed.Type>((dispatch) =>
  Stream.runForEach(Stream.make(10, 20), (percent) => dispatch(Progressed.make({ percent }))),
);

console.log(loopback._tag);
// => "Effect"
```

Inside a handler's return, `dispatch` is typed from the contextual return
type of the reducer. A command written standalone has no such context, so it
names its own vocabulary, as `loopback` does.

## Concurrency belongs to Effect

Debounce, throttle, retry and take-latest are Effect combinators. A
throttled progress report is `Stream.throttle` where the work is written.

```ts continue
const throttled = (name: string) =>
  Command.effect<typeof Progressed.Type, Uploads>((dispatch) =>
    Effect.flatMap(Uploads, (uploads) =>
      Stream.runForEach(
        uploads
          .upload(name)
          .pipe(Stream.throttle({ cost: () => 1, units: 1, duration: "100 millis" })),
        (percent) => dispatch(Progressed.make({ percent })),
      ),
    ).pipe(Effect.catchCause(() => E.void)),
  );
```

A policy vocabulary written as data could only be a smaller copy of that.
The runtime owns the one thing a handler cannot write for itself: naming a
running fiber so a _different_ action's handler can interrupt it. That is
`Command.keyed` and `Command.cancel`, and it is the whole supervisor. The
`Cancelled` handler above reaches work `Picked` started, by name. See
[groups and cancellation](/docs/explanation/groups-and-cancellation).

```ts continue
const stopped = await Effect.runPromise(
  uploader.run([Picked.make({ name: "photo.jpg" }), Cancelled.make({})], {
    props: {},
    hooks: {},
    layer: Layer.succeed(Uploads)({
      upload: () => Stream.fromEffect(Effect.sleep("50 millis").pipe(Effect.as(100))),
    }),
  }),
);

console.log(stopped.emitted);
// => []
console.log(stopped.state.status);
// => "cancelled"
```

## A command can be lazy

A handler that writes state inline often needs that same state in the
command. The lazy form hands the thunk the state it sits beside, so the
handler keeps its one-expression body.

```ts continue
const lazily = Uploader.reducer({
  Picked: ({ name }, { state }) => [
    { ...state, name, percent: 0, status: "uploading" },
    (next) =>
      Command.effect((dispatch) =>
        Effect.flatMap(Uploads, (uploads) =>
          Stream.runForEach(uploads.upload(next.name), (percent) =>
            dispatch(Progressed.make({ percent })),
          ),
        ).pipe(Effect.catchCause(() => E.void)),
      ),
  ],
  Progressed: ({ percent }, { state }) => ({ ...state, percent }),
  Finished: (_payload, { state }) => ({ ...state, status: "done" }),
  Failed: ({ message }, { state }) => ({ ...state, status: message }),
  Cancelled: (_payload, { state }) => [{ ...state, status: "cancelled" }, Command.cancel("upload")],
});
```

`Next.command` is the single resolution point. It calls the thunk once,
with the tuple's own state, and returns what it returned. `reduce`'s
`Unmounted` branch, `run`, the store's fold and its teardown all read
through that accessor, so a lazy command reaches the interpreter already
resolved. A `Lazy` ADT variant would put a second resolution site in every
consumer, and devtools would report a function where a command belongs.

```ts continue
const lazyNext: Next<{ name: string }, never> = [{ name: "a.jpg" }, () => Command.none];
console.log(Next.command(lazyNext)?._tag);
// => "None"
```

## Commands cannot fail

The leaf's error channel is `never`. An effect with an open error channel
does not compile.

```ts continue
// @ts-expect-error a command's error channel is `never`
const failing = Command.effect(() => Effect.fail("boom"));
```

This is deliberate. A failure the feature cares about is part of its model:
the user sees it, so it belongs in an action payload or a
[task](/docs/reference/tasks) field. `Effect.catchCause` inside the leaf
turns the failure into a dispatch, which is what the `Picked` handler does
with `Failed`. The React version put the same fact in a `catch` block that
called `setError`, where no test could reach it without a render.

```ts continue
const broken = Layer.succeed(Uploads)({
  upload: () => Stream.fail(new Error("disk full")),
});

const failed = await Effect.runPromise(
  uploader.run([Picked.make({ name: "photo.jpg" })], { props: {}, hooks: {}, layer: broken }),
);

console.log(failed.state.status);
// => "Error: disk full"
```

What remains is a defect: a bug in the effect, or a feature layer that fails
to build. Under a mount both reach the `Error` lifecycle handler. With no
handler the defect is rethrown during render, which is the only place a
React error boundary can catch it. Interruption is how commands normally
end, so a cancelled or unmounted fiber is never reported as a defect.

## Two limits

`run` counts in-flight work to decide when it is finished, so a command that
never completes keeps it from resolving. Test a subscription by cancelling
it, as `stopped` does above, or fold it through `reduce` and read the
command.

`run` also discards a command that dies. The store routes a dying command to
the `Error` handler; `run` does not, so a test of "given a failing command,
this feature recovers" passes without checking anything. That is an open
item in the runtime, and until it closes the honest test for a defect is a
mounted component with a recorder. Constructor signatures are in
[commands](/docs/reference/commands).
