# Docs rewrite queue

Not shipped in the tarball and not a site page. One line per item: what is
weak, what the rewrite should do, status.

Pass 1 (2026-09-04) covered the home page, `index.md`, and every
`explanation/` page, plus the tooling: the code ratio is a suggestion and
contrast is allowed in explanation pages. The rules live in
`.claude/agents/wych-docs-author.md`.

Voice for every page: open from the React developer's problem, assume Effect
literacy, STE100 sentences, no "TEA-style", no "quiescence" above the fold.

## Tutorial

- [ ] `01-your-first-feature.md`: no narrative tension. Add one wrong turn per
      chapter (e.g. reach for `useState` in `render`, see why it is invisible
      to `reduce`) and correct it. Keep the file set and the example.
- [ ] `02-async-work.md`: the `Task` section states facts the reader has not
      needed yet. Motivate `Pending` on the same fold with a double-submit
      before introducing `Task.start`.
- [ ] `03-composing-features.md`: outputs land without the callback-prop pain
      that explains them. One paragraph from `explanation/actions-and-outputs`
      opening, then the code.

## How-to

Common weakness: 16-24 prose lines against 60-200 code lines. Each recipe
needs the one or two decisions the reader has to make, in prose, beside the
file.

- [ ] `debounce-and-take-latest.md`: say when the debounce belongs in `run`
      versus in the handler's leaf; say what `mode: "every"` is for.
- [ ] `subscribe-to-a-stream.md`: say why `Unmounted` still cancels when React
      unmount already sweeps (the `run` and manual-teardown cases).
- [ ] `test-a-feature-without-react.md`: say which of `reduce`/`run`/recorder to
      pick for which claim; note that `run` discards a dying command.
      Its fences import `expect`/`test` from `vite-plus/test` because
      `docs-check` only recognises that specifier as a test file; readers use
      `vitest`. Either teach `docs-check` to accept `vitest` or show the
      example's real file as a fragment, as tutorial chapter 1 does.
- [ ] `render-on-the-server.md`: fine as a recipe; add the hydration mismatch
      symptom the reader will actually see.
- [ ] `install-devtools.md`: fine; check the options list against
      `ConsoleDevtoolsOptions` after any devtools change.
- [ ] `use-with-ai-agents.md`: the section on why the model suits an agent
      duplicates the home page and should point there. (URLs moved to
      `wych.build` on 2026-09-04.)
- [ ] `use-with-the-react-ecosystem.md`: opening list is contrastive ("not a
      store, not atoms"); how-to pages keep the contrast ban.

## Reference

Adequate as lookup. Light pass only.

- [ ] `lifecycle.md`: the "Order" list omits `Error`; add it with when it can
      fire (any time after `Mounted`, including during teardown).
- [ ] `commands.md`, `features.md`, `runtime.md`, `actions.md`, `tasks.md`,
      `devtools.md`: replace spec-voice sentences ("X is the single resolution
      point") with the contract in plain words; keep every signature block and
      snippet.
- [ ] Reference pages reuse the search box and the cart heavily; acceptable in
      reference, but each page's running example should not repeat another
      reference page's domain where a cheap alternative exists.

## Outside `docs/`

- [x] `packages/react/README.md`: opening realigned, status section added,
      site link added (2026-09-04). Still definition-shaped by decision.
- [ ] Home page (`packages/website/app/page.tsx`): the hero test caption and
      the agent section were tightened in pass 1; revisit after the tutorial
      rewrite so the "Start the tutorial" promise matches chapter 1's opening.
- [ ] Example `readme.md` files: still written from the old rules; the five
      mandatory sections stay, the Problem section should open from the React
      pain the matching docs page uses.

## Style sweep

- [ ] `Effect.gen` over `flatMap` chains (2026-09-04 rule): the tutorial and
      its examples are converted. Sweep `index.md`, `explanation/*`, `how-to/*`,
      `reference/*`, the remaining examples, the README and the home hero pair.

- [ ] Terminology: "arm" and "total" for `Task.match` and `Action.of` matchers
      become "case" and "exhaustive" (2026-09-04). Tutorial done; sweep
      `reference/tasks.md` and `reference/devtools.md`, and the JSDoc in
      `src/utils/task.ts` if the change is wanted in source.

## Tooling

- [ ] `feature.run` seeds every action before the first command's fiber
      starts, so a `"latest"` interrupt between two seeded actions lands before
      the first request leaves. No page can show a mid-flight interrupt
      through `run` today (tutorial chapter 2 describes it in prose instead).
      Consider a seed form that yields between actions, or a browser example.

- [ ] `docs-check`: a multi-line `// =>` literal after `console.log` is a parse
      error in `--run` mode (the regex takes one line). Either join lines in the
      transform or document the one-line rule in the script header.
- [ ] `docs-check`: deep-equality on a command value fails on its `pipe`
      method; docs use `summarizeCommand` or `?._tag`. Consider stripping
      functions in `toAssertions`, or leave as is and note it in the header.
- [ ] Step 3 of the StackBlitz plan: a drift guard that each page fence appears
      in its example's files.
