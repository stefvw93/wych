// Writes a synthetic feature with `actions` actions (one handler each) and
// `tasks` slot tasks into `out`, in the shape lsp-bench.mjs reads: a
// todos.tsx carrying the same markers, and the fixture's tsconfig. Run the
// LSP bench over a few sizes to see how the reducer paths scale.
//
//   node bench/types/scale.mjs <out> <actions> <tasks>
//   FIXTURE=<out> node bench/types/lsp-bench.mjs
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [out, actionCount = "10", taskCount = "4"] = process.argv.slice(2);
const N = Number(actionCount);
const M = Number(taskCount);
mkdirSync(out, { recursive: true });
copyFileSync(join(here, "fixture/tsconfig.json"), join(out, "tsconfig.json"));

const lines = [];
const push = (...xs) => lines.push(...xs);
push(
  `import { Effect, Schema } from "effect";`,
  `import { Action, Task, createRuntime, define } from "@wych/react";`,
  ``,
  `const /*@control*/plain = 1;`,
  `export const control = plain;`,
  ``,
  `const Item = Schema.Struct({ id: Schema.String, url: Schema.URLFromString, at: Schema.DateFromString, tags: Schema.Array(Schema.String) });`,
);
for (let t = 0; t < M; t++) {
  push(
    `const Load${t} = Task("Load${t}", {`,
    `  success: Schema.Struct({ items: Schema.Array(Item), page: Schema.Number }),`,
    `  run: (page: number) => Effect.succeed({ items: [], page }),`,
    `});`,
  );
}
push(
  `const State = Schema.Struct({`,
  ...Array.from(
    { length: Math.max(4, N / 2) },
    (_, i) => `  field${i}: Schema.${i % 3 === 0 ? "String" : i % 3 === 1 ? "Number" : "Boolean"},`,
  ),
  `  selected: Schema.optional(Schema.URLFromString),`,
  `});`,
  `const actions = Action({`,
  ...Array.from(
    { length: N },
    (_, i) => `  Did${i}: { value: Schema.${i % 2 ? "Number" : "String"}, page: Schema.Number },`,
  ),
  `});`,
  `const Def = define({`,
  `  props: Schema.Struct({}),`,
  `  state: State,`,
  `  tasks: { ${Array.from({ length: M }, (_, t) => `load${t}: Load${t}`).join(", ")} },`,
  `  actions,`,
  `});`,
  `const initialState = Def.initialState(() => ({`,
  ...Array.from(
    { length: Math.max(4, N / 2) },
    (_, i) => `  field${i}: ${i % 3 === 0 ? `""` : i % 3 === 1 ? "0" : "false"},`,
  ),
  `}));`,
  `const reducer = Def.reducer({`,
  `  /*@newKey*/`,
);
const fields = Math.max(4, N / 2);
for (let i = 0; i < N; i++) {
  // A field of the type the handler writes: fields cycle String, Number, Boolean.
  const f = `field${(i % 3) + 3 * (Math.floor(i / 3) % Math.max(1, Math.floor(fields / 3)))}`;
  const val = i % 3 === 0 ? `String(value)` : i % 3 === 1 ? `Number(page)` : `page > 0`;
  const last = i === N - 1;
  const [keyMark, draftMark, tasksMark, draftDot, tasksDot] = last
    ? ["/*@hoverKey*/", "/*@hoverDraft*/", "/*@hoverTasks*/", "/*@draftDot*/", "/*@tasksDot*/"]
    : ["", "", "", "", ""];
  if (M > 0 && i % 2 === 1) {
    push(
      `  ${keyMark}Did${i}: ({ value, page }, { state, ${draftMark}draft, ${tasksMark}tasks }) => {`,
      `    ${draftDot}draft.${f} = ${val};`,
      `    void [state, value];`,
      `    return ${tasksDot}tasks.load${i % M}.start(page);`,
      `  },`,
    );
  } else {
    push(
      `  ${keyMark}Did${i}: ({ value, page }, { state, ${draftMark}draft, ${tasksMark}tasks }) => {`,
      `    ${draftDot}draft.${f} = ${val};`,
      `    void [state, value, page];`,
      `    void ${tasksDot}tasks;`,
      `    return draft;`,
      `  },`,
    );
  }
}
push(
  `});`,
  `const render = Def.render(({ state }) => <p>{String(state.field0)}</p>);`,
  `const { component } = createRuntime(undefined as never);`,
  `export const Feature = component(Def.create({ initialState, reducer, render }), { name: "Feature" });`,
);
writeFileSync(join(out, "todos.tsx"), lines.join("\n") + "\n");
