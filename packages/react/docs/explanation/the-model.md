---
title: The model
description: What a useEffect graph is hiding, and the shape that replaces it.
order: 1
---

# The model

A login form in React starts small. Two inputs, a button, a request. Then
the button has to disable while the request is out, the error has to render,
a second click has to be ignored, and an unmount mid-request has to drop the
response. Each rule lands in a different hook.

```tsx
import { useEffect, useRef, useState } from "react";

declare function signIn(email: string, password: string): Promise<string>;

export const LoginForm = ({ onSignedIn }: { readonly onSignedIn: (userId: string) => void }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const submit = async () => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const userId = await signIn(email, password);
      if (alive.current) onSignedIn(userId);
    } catch (thrown) {
      if (alive.current) setError(String(thrown));
    } finally {
      if (alive.current) setPending(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input value={email} onChange={(event) => setEmail(event.target.value)} />
      <input value={password} onChange={(event) => setPassword(event.target.value)} />
      <button disabled={pending}>Sign in</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
};
```

Nothing here is wrong. The problem is where the rules live. `pending` and
`error` can disagree, because two `useState` calls have no shared
transition. The double-submit guard reads a closure that may be stale. The
`alive` ref exists because React has no name for "the request this component
started". And none of it can be exercised without rendering the form.

Elm answered this in 2012: state is a fold over messages, and work is a value
the fold returns. Wych is that answer on React, with
[Effect](https://effect.website) as the work.

## The reducer describes, the runtime does

A feature is declared from values. Props and state are `Schema.Struct`s, and
the actions are a tagged union. A `Task` declares the request as two actions
and a command.

```tsx
import { Context, Effect, Layer, Schema } from "effect";
import { Action, Command, createRuntime, define, Next, Task } from "@wych/react";

class Auth extends Context.Service<
  Auth,
  { readonly signIn: (email: string, password: string) => Effect.Effect<string, Error> }
>()("Auth") {}

const EmailTyped = Action("EmailTyped", { email: Schema.String });
const PasswordTyped = Action("PasswordTyped", { password: Schema.String });
const Submitted = Action("Submitted", {});
const SignedIn = Action.output("SignedIn", { userId: Schema.String });

const login = Task("Login", {
  success: Schema.String,
  onError: Task.errorMessage,
  run: (credentials: { readonly email: string; readonly password: string }) =>
    Effect.gen(function* () {
      const auth = yield* Auth;
      return yield* auth.signIn(credentials.email, credentials.password);
    }),
});

const Login = define({
  props: Schema.Struct({}),
  state: Schema.Struct({
    email: Schema.String,
    password: Schema.String,
    session: Task.schema(Schema.String),
  }),
  action: Action.of([EmailTyped, PasswordTyped, Submitted, ...login.actions]),
  output: Action.of([SignedIn]),
});
```

That block is the whole contract: what the feature holds, what it can do,
what it tells its parent. The React version spread the same facts over four
`useState` calls, a ref and a callback prop.

The reducer is one pure function of `(payload, snapshot)`. A handler returns
the next state, or the next state beside a `Command`.

A draft does not change this. `snapshot.draft` is a mutable view of `state`;
the handler still returns the next state, now written by mutating the draft
instead of spreading it. The runtime finishes the draft into a plain frozen
value before anything else reads it, and nothing outside the handler ever
sees the proxy.

```tsx continue
const loginForm = Login.create({
  initialState: () => ({ email: "", password: "", session: Task.idle }),
  reducer: {
    EmailTyped: ({ email }, { draft }) => {
      draft.email = email;
      return draft;
    },
    PasswordTyped: ({ password }, { draft }) => {
      draft.password = password;
      return draft;
    },
    Submitted: (_payload, { draft, state }) =>
      Task.isPending(state.session)
        ? draft
        : Task.start(draft, "session", login.run({ email: state.email, password: state.password })),
    LoginResolved: ({ value }, { draft }) => {
      draft.session = Task.resolved(value);
      return [draft, Command.output(SignedIn, { userId: value })];
    },
    LoginRejected: ({ error }, { draft }) => {
      draft.session = Task.rejected(error);
      return draft;
    },
  },
  render: ({ state, dispatch }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        dispatch(Submitted.make({}));
      }}
    >
      <input
        value={state.email}
        onChange={(event) => dispatch(EmailTyped.make({ email: event.target.value }))}
      />
      <input
        value={state.password}
        onChange={(event) => dispatch(PasswordTyped.make({ password: event.target.value }))}
      />
      <button disabled={Task.isPending(state.session)}>Sign in</button>
      {Task.isRejected(state.session) && <p role="alert">{state.session.error}</p>}
    </form>
  ),
});
```

Every rule from the React version is in the reducer. `pending` and `error`
are one field with four cases, so they cannot disagree. The double-submit
guard reads the state the fold was handed, never a stale closure. The
`alive` ref is gone: state lives at the store, not the component, so a
login that resolves after unmount folds safely into state nothing renders,
instead of calling `setState` on a component that is gone.

The `Submitted` handler does not sign in. It returns a description of signing
in, and `Task.start` writes `Pending` beside it on the same fold. Who runs
the description is the runtime's business.

## One reducer, three readers

`feature.reduce` is the reducer as a function. No React, no Effect runtime,
no service. It answers "given this state and this action, what happens next"
and hands the command back as data.

```tsx continue
const pending = {
  state: { email: "ada@example.com", password: "hunter2", session: Task.pending },
  props: {},
  hooks: {},
};

const ignored = loginForm.reduce(Submitted.make({}), pending);

console.log(Next.state(ignored) === pending.state);
// => true
console.log(Next.command(ignored));
// => undefined
```

`feature.run` folds a sequence, runs each command against a `Layer`, feeds
what a command dispatches back in, and resolves when nothing is left
running. The React version could show this only through a rendered form and
a mocked network.

```tsx continue
const auth = Layer.succeed(Auth)({
  signIn: (email) => Effect.succeed(`user_${email.split("@")[0]}`),
});

const signedIn = await Effect.runPromise(
  loginForm.run(
    [
      EmailTyped.make({ email: "ada@example.com" }),
      PasswordTyped.make({ password: "hunter2" }),
      Submitted.make({}),
    ],
    { props: {}, hooks: {}, layer: auth },
  ),
);

console.log(signedIn.emitted);
// => [{ _tag: "LoginResolved", value: "user_ada" }]
console.log(signedIn.outputs);
// => [{ _tag: "SignedIn", userId: "user_ada" }]
console.log(signedIn.state.session);
// => { _tag: "Resolved", value: "user_ada" }
```

`component` is the React binding. It mounts the feature, folds every
dispatch, forks every command into the mount's scope, and paints `render`.
The output becomes a required `onSignedIn` prop.

```tsx continue
const { component } = createRuntime(auth);
export const LoginView = component(loginForm, { name: "Login" });

// <LoginView onSignedIn={({ userId }) => navigate(`/users/${userId}`)} />
```

All three read commands through one interpreter, so grouping and
cancellation have one implementation and `Next.command` is the one place a
[lazy command](/docs/explanation/commands-as-data#a-command-can-be-lazy)
resolves. A test written with `run` therefore measures the
behaviour the mounted component has. Two interpreters would have to agree
forever, and they would drift.

## Where React state hooks fit

Feature state lives in the feature. `render` holds no `useState`, no
`useReducer` and no `useEffect`; a view fragment under the mount reads the
same snapshot through `LoginView.useFeature()`.

```tsx continue
const SubmitButton = () => {
  const { state, dispatch } = LoginView.useFeature();
  return (
    <button disabled={Task.isPending(state.session)} onClick={() => dispatch(Submitted.make({}))}>
      Sign in
    </button>
  );
};
```

Two reasons for the rule. State kept in React is invisible to `reduce` and
`run`, so it cannot be tested headless or shown in devtools. Work started in
`useEffect` is outside the fiber book, so no action can cancel it and unmount
does not know it exists.

Some inputs only exist in React: a router, a media query, a data-fetching
hook from another library. `useUnsafeHooks` calls them in render position and
hands the values to the reducer as `hooks`, and a change raises
`HookChanged`.

```tsx
import { Schema } from "effect";
import { Action, define } from "@wych/react";

declare function useOnlineStatus(): boolean;

const EmailTyped = Action("EmailTyped", { email: Schema.String });

const Login = define({
  props: Schema.Struct({}),
  state: Schema.Struct({ email: Schema.String, offline: Schema.Boolean }),
  action: Action.of([EmailTyped]),
  useUnsafeHooks: () => ({ online: useOnlineStatus() }),
});

const loginForm = Login.create({
  initialState: () => ({ email: "", offline: false }),
  reducer: {
    EmailTyped: ({ email }, { draft }) => {
      draft.email = email;
      return draft;
    },
    HookChanged: (_payload, { draft, hooks }) => {
      draft.offline = !hooks.online;
      return draft;
    },
  },
  render: ({ state }) => (state.offline ? "offline" : state.email),
});
```

It is named unsafe because it opens the feature to whatever the hook does. A
hook that reads ambient input is fine. A hook that owns state the feature
should own moves the feature back into React, one `useState` at a time.

## Two kinds of work, kept apart

Elm keeps commands and subscriptions apart, for a reason worth carrying over:
a command is _issued_ and finishes, a subscription is _declared_ and the
runtime keeps it running until the feature stops declaring it. Wych keeps the
same split. `Command.effect` is a leaf that runs once and settles. A feature
that needs a websocket, a presence feed or a `Stream.tick` declares it through
a `subscriptions` hook on `create`, keyed on the snapshot; the runtime diffs
the declared keys after every fold and starts or stops fibers to match. See
[Subscriptions](/docs/reference/subscriptions) for the hook and the key rule.

`run` resolves at command quiescence: nothing queued, no command fiber in
flight. A subscription fiber does not count. A subscription over a
synchronous stub, `Stream.fromArray` or `Stream.make`, has already emitted by
the time `run` resolves, so it is testable with `run` on the same terms as a
command. An endless subscription, `Effect.never` or a live stream, holds
nothing open: `run` interrupts every subscription fiber it started once
command work settles.

A command that never completes is a different case. It still keeps `run`
open, because a command that runs forever has not finished, and finishing is
what makes it a command. That is a long-lived source written in the wrong
place; move it into a subscription. See
[groups and cancellation](/docs/explanation/groups-and-cancellation) for how
a command is booked and cancelled, and
[commands as data](/docs/explanation/commands-as-data) for why a command is a
value in the first place.
