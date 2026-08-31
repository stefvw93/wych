---
title: Tasks
description: Async work split into an operation and a four-case value.
order: 5
---

# Tasks

`Task` splits async work into the two halves it actually has.

- **The operation** — `Task(name, { success, failure?, onError, mode?, run? })`
  declares two actions and the command that produces them. It owns the _work_:
  scheduling it, interrupting it, turning however it ended into one of two
  actions. It writes nothing into state.
- **The value** — `TaskValue<A, E>` is `Idle | Pending | Resolved { value } |
Rejected { error }`, with `Task.schema` for the state field, a total `match`
  for render, partial reads and guards, and `Task.start` to write `Pending`
  beside a command.

Nothing connects the two but the handlers you write. That is the point: the
field is declarable before the operation exists, an operation is declarable for
a feature that stores nothing, and where a result lands is visible in the file
that owns it.

## The operation

```ts
const search = Task("Search", {
  success: Schema.Array(Result),
  failure: Schema.String,
  onError: (cause) => Task.message(cause),
  mode: "latest",
  run: (query: string) => fetchResults(query),
});
```

`Task(…)` returns exactly `{ actions, run, cancel }` — nothing state-shaped.

`actions` is `[SearchResolved { value }, SearchRejected { error }]`, spreadable
into `Action.of` beside hand-written actions:

```ts
action: Action.of([Action("QueryChanged", { q: Schema.String }), ...search.actions]);
```

A lower-case `name` is a compile error, on the same terms as an action tag.

- Success dispatches `${Name}Resolved`, and lands in whatever field your handler
  writes.
- A typed failure **and a defect** both pass through `onError` and dispatch
  `${Name}Rejected` — nothing reaches the `Error` lifecycle handler.
- **Interruption dispatches nothing.**

### Modes

`"latest"` interrupts the in-flight run — a second `run` yields exactly one
`Resolved`, carrying the second's value. `"every"` runs both to completion and
emits both. There is no `"first"` mode: take-first is a handler guard.

```ts
QueryChanged: ({ q }, { state }) =>
  Task.isPending(state.results) ? state : Task.start(state, "results", () => search.run(q));
```

`cancel` is `Command.cancel("Task/${Name}")` — it interrupts in-flight work
without emitting.

Without a declared `run`, the operation's `run` takes an effect and carries its
`R`, so a missing service is still a compile error at `component`.

`Task.output(name, …)` is the same operation with both actions on the outbound
channel: results are announced rather than folded.

## The value

```ts
state: Schema.Struct({ results: Task.schema(Schema.Array(Result), Schema.String) });
```

`Task.start(state, key, thunk)` writes `Pending` into the field and returns the
`[state, command]` tuple. `Pending` is written **synchronously** on the fold
that issues the command — `feature.reduce(Clicked, snapshot)` already shows it
in the returned state.

Render with the total match — all four arms are required:

```ts
Task.match(state.results, {
  Idle: () => null,
  Pending: () => <Spinner />,
  Resolved: ({ value }) => <List items={value} />,
  Rejected: ({ error }) => <Error message={error} />,
});
```

Elsewhere, use the partial reads and guards: `Task.value`, `Task.error`,
`Task.getOrElse`, `Task.isPending`. The guards narrow `value` / `error` inside
the branch.
