/**
 * `Task` under its two modes: `latest` desugars to `Command.restart`, `every`
 * to `Command.keyed`. Fifty issues per iteration, trivial work.
 */
import { Effect, Schema } from "effect";
import { bench, describe } from "vite-plus/test";
import { silentRuntime, spinSettle, storeArgs } from "../__fixtures__/stress";
import { Action, createFeatureStore, define } from "../lib";
import { Task, type TaskMode } from "./task";

const runtime = silentRuntime();

const storeFor = (mode: TaskMode) => {
  const load = Task("Load", {
    success: Schema.Number,
    onError: Task.errorMessage,
    mode,
    run: (n: number) => Effect.succeed(n),
  });
  const Issue = Action("Issue", { n: Schema.Number });
  const feature = define({
    props: Schema.Struct({}),
    state: Schema.Struct({ value: Task.schema(Schema.Number) }),
    actions: [Issue, ...load.actions],
  }).create({
    initialState: () => ({ value: Task.idle }),
    reducer: {
      Issue: ({ n }, { state }) => Task.start(state, "value", load.run(n)),
      LoadResolved: ({ value }) => ({ value: Task.resolved(value) }),
      LoadRejected: ({ error }) => ({ value: Task.rejected(error) }),
    },
    render: () => null,
  });
  const store = createFeatureStore({
    feature,
    props: {},
    ...storeArgs(runtime, Schema.Struct({})),
  });
  store.start();
  return { store, Issue };
};

describe("Task.run", () => {
  for (const mode of ["latest", "every"] as const) {
    const { store, Issue } = storeFor(mode);
    const issues = Array.from({ length: 50 }, (_, n) => Issue.make({ n }));

    bench(`mode ${mode}: 50 issues and settle`, async () => {
      for (const issue of issues) store.dispatch(issue);
      await spinSettle(store);
    });
  }
});
