/**
 * What a live devtools sink adds to a fold. Compared against `lib.bench.test.ts`
 * "dispatch: no sink, no hook".
 */
import { Layer, ManagedRuntime } from "effect";
import { bench, describe } from "vite-plus/test";
import { Bump, counterStore } from "./__fixtures__/stress";
import {
  createConsoleDevtools,
  devtoolsLayer,
  type DevtoolsConsole,
  type DevtoolsSink,
} from "./devtools";

const withSink = (sink: DevtoolsSink) => ManagedRuntime.make(devtoolsLayer(sink));

/** A console that does nothing, so the logger's own work is what is measured. */
const silentConsole: DevtoolsConsole = {
  group: () => {},
  groupCollapsed: () => {},
  groupEnd: () => {},
  log: () => {},
  error: () => {},
};

describe("fold with a sink", () => {
  const action = Bump.make({});

  let count = 0;
  const counting = counterStore(withSink({ onEvent: () => void (count += 1) }));
  counting.start();

  bench("dispatch: counting sink", () => {
    counting.dispatch(action);
  });

  const plain = counterStore(
    withSink(createConsoleDevtools({ console: silentConsole, timestamps: true })),
  );
  plain.start();

  bench("dispatch: console sink, diff off", () => {
    plain.dispatch(action);
  });

  const diffed = counterStore(
    withSink(createConsoleDevtools({ console: silentConsole, timestamps: true, diff: true })),
  );
  diffed.start();

  bench("dispatch: console sink, diff on", () => {
    diffed.dispatch(action);
  });

  // Control: the same store shape on a sink-less runtime, in this file, so
  // the comparison does not cross a process boundary.
  const bare = counterStore(ManagedRuntime.make(Layer.empty));
  bare.start();

  bench("dispatch: no sink (control)", () => {
    bare.dispatch(action);
  });
});
