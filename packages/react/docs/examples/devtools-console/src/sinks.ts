// Alternative sinks. Swap any of these for `consoleDevtoolsLayer()` in runtime.ts.
import type { DevtoolsEvent } from "@wych/react";
import { createConsoleDevtools, devtoolsLayer, skipUnchanged } from "@wych/react";

/** Every console option, spelled out. */
export const verbose = devtoolsLayer(
  createConsoleDevtools({
    collapsed: false,
    diff: true,
    timestamps: false,
  }),
);

/** Drop any transition that did not move state. */
export const quiet = devtoolsLayer(createConsoleDevtools({ predicate: skipUnchanged }));

/** Keep one component's events. */
export const onlyCounter = devtoolsLayer(
  createConsoleDevtools({ predicate: (event) => event.name === "Counter" }),
);

/** Forward every event to another window. Events are plain data, no serialiser. */
export const bridge = devtoolsLayer({
  onEvent: (event: DevtoolsEvent) => {
    window.postMessage({ source: "wych", event }, "*");
  },
});
