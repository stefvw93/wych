---
title: Devtools
description: An RTK-style logger installed as an Effect service.
order: 6
---

# Devtools

Observation is a **service installed through the root layer**, not a runtime
option. Being a service is the point: the sink is swappable — a console logger,
an in-memory recorder for tests, a transport later — and costs nothing when
nobody installs one. The store allocates nothing at the emission sites when
there is no sink.

## Installing a sink

```ts
import { Layer } from "effect";
import { createRuntime, consoleDevtoolsLayer } from "@wych/react";

const { component } = createRuntime(
  Layer.mergeAll(AppServices, import.meta.env.DEV ? consoleDevtoolsLayer() : Layer.empty),
);
```

`consoleDevtoolsLayer(options?)` is `devtoolsLayer(createConsoleDevtools(options))` —
the one-liner an app installs. `Devtools` is a `Context.Reference` with a no-op default, so reading it can
never fail and never widens `R`.

**The sink is synchronous.** The fold is a plain function; only commands are
Effects. A sink returning an `Effect` would put a forked fiber and a scheduler
hop on the hottest path in the library, and the log could land after the state
had already moved on.

## Events

Four shapes share one envelope: `DevtoolsTransition`, `DevtoolsCommand`,
`DevtoolsOutput` and `DevtoolsDefect`. Every event is JSON-round-trippable —
opaque props such as `children` are replaced by a placeholder before they reach
the sink.

## Filtering

```ts
import { skipUnchanged, skipUnchangedAmbient } from "@wych/react";
```

`skipUnchangedAmbient` drops lifecycle events that moved nothing;
`skipUnchanged` drops any transition whose state is unchanged.

## Recording, for tests

```ts
import { createRecorder, devtoolsLayer } from "@wych/react";

const recorder = createRecorder();
await feature.run(actions, { layer: devtoolsLayer(recorder) });
recorder.events; // every event, in order
```
