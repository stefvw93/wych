# Docs rewrite queue

Not shipped in the tarball and not a site page. One line per item: what is
weak, what the rewrite should do, status.

Pass 1 (2026-09-04) covered the home page, `index.md`, and every
`explanation/` page, plus the tooling: the code ratio is a suggestion and
contrast is allowed in explanation pages. The rules live in
`.claude/agents/wych-docs-author.md`.

Pass 2 (2026-09-06) covered everything below that is checked. Writers were
Fable agents working from the agent rules file; the `wych-docs-author` agent
reviewed the result.

Voice for every page: open from the React developer's problem, assume Effect
literacy, STE100 sentences, no "TEA-style", no "quiescence" above the fold.

## Tutorial

Rewritten in `c3e5f14` (2026-09-04); checked against the briefs below on
2026-09-06.

- [x] `01-your-first-feature.md`: rewritten; opens from the editor's job and
      ends with a DOM-free test. A `useState` wrong turn was added and then
      removed on 2026-09-06: the tutorial keeps one safe path, so step 5 has a
      one-sentence aside instead of a detour.
- [x] `02-async-work.md`: section 4 runs a double-submit through `run` and
      guards it by hand before section 5 introduces `Task.start`. Its `drift`
      count (36) is the by-hand detour and the inline `run` demos, which the
      example does not ship on purpose.
- [x] `03-composing-features.md`: opens with props down, outputs up and the
      `onSaved` prop before the code.

## How-to

Each recipe now carries the one or two decisions the reader has to make, in
prose beside the file. Prose lines roughly doubled per page; ratios stay
above the floor.

- [x] `debounce-and-take-latest.md`: "Where the delay lives" says when the
      delay belongs in `run` (every caller waits) versus the handler's leaf
      (one action waits); "Compare" says what `mode: "every"` is for and why
      a search box keeps `"latest"`.
- [x] `subscribe-to-a-stream.md`: says why `Unmounted` still cancels (a mount
      sweeps before the `Unmounted` command runs; `run` sweeps nothing, so the
      handler is what ends a `run` over an endless source), demonstrated with
      `Stream.never`.
- [x] `test-a-feature-without-react.md`: `reduce` / `run` / recorder, one
      claim each; the `run` yield-per-action behaviour is demonstrated; the two
      limits of `run` (never-completing command, dying command discarded) are
      stated. Fences import from `vitest`; `docs-check` rewrites the specifier.
- [x] `render-on-the-server.md`: shows the real React 19 hydration warning
      text and its two feature-level causes. Corrected: a `Mounted` command is
      not a mismatch source, it folds after commit.
- [x] `install-devtools.md`: options checked against `ConsoleDevtoolsOptions`;
      two corrections (`timestamps` is per mount, `console` takes five
      methods). Re-check after any devtools change.
- [x] `use-with-ai-agents.md`: the "why the model suits an agent" section is
      gone; one sentence points at the home page section. Task-shaped
      otherwise.
- [x] `use-with-the-react-ecosystem.md`: opens from the reader's app; the
      contrastive list is gone; one running file with the three integration
      points; drift 43 to 3 (the API stubs, deliberate).

## Reference

- [x] `lifecycle.md`: `Error` is in the Order list, from the mount effect on,
      including teardown; a throwing handler is named as a third source and
      `cause` is `Cause.die(error)` (source and spec synced the same day).
- [x] Spec-voice sentences replaced across `commands.md`, `features.md`,
      `runtime.md`, `actions.md`, `tasks.md`, `devtools.md`; every signature
      block and snippet kept.
- [x] Running examples: `actions.md` moved to a poll widget, `tasks.md` to a
      mailbox loader; the search box lives on `commands.md` only.

## Outside `docs/`

- [x] `packages/react/README.md`: opening realigned, status section added,
      site link added (2026-09-04). Still definition-shaped by decision. No
      `flatMap` chains to sweep.
- [x] Home page (`packages/website/app/page.tsx`): checked 2026-09-06 against
      chapter 1's opening; the hero pair, caption and "Start the tutorial"
      blurb agree, nothing changed. `llms.txt` fallback description now
      matches `index.md`.
- [x] Example `readme.md` files: every Problem section opens from the React
      pain its docs page uses; five sections kept.

## Style sweep

- [x] `Effect.gen` over `flatMap` chains: swept across `index.md` (none),
      `explanation/*`, `how-to/*`, `reference/*`, every example, the README
      (none) and the home hero pair (none). A single combinator on a finished
      effect keeps `.pipe`.
- [x] Terminology "case"/"exhaustive" in docs: `reference/tasks.md` and
      `reference/devtools.md` done.
- [x] Terminology in source: the JSDoc and comments in `src/utils/task.ts`
      say "case" and "exhaustive" (2026-09-06). `src/utils/task.specs.md`
      keeps "arm" and "total": specs have their own prose style by decision.

## Tooling

- [x] `feature.run` now yields once after each action is reduced
      (2026-09-06), so a later seeded action's `restart` interrupts a request
      the earlier one already sent. Spec line under `Feature.run`, test in
      `lib.test.ts`. The test how-to demonstrates it.
- [x] `docs-check`: a multi-line `// =>` literal is joined until its brackets
      balance; header documents it.
- [x] `docs-check`: deep-equality on a command value is documented in the
      header as a one-line rule (log `summarizeCommand(cmd)` or `cmd?._tag`);
      `toAssertions` is unchanged.
- [x] `docs-check` runs snippets through `vp test` (the `vitest` bin no longer
      exists in the workspace) and reports a spawn failure by message. The
      `docs` vitest project needs Playwright's Chromium for the provider's
      pinned build: install it through the `playwright` copy under
      `node_modules/.pnpm/@vitest+browser-playwright*/node_modules/playwright`
      (`node <that>/cli.js install chromium`); the root `playwright` fetches a
      different build.
- [x] StackBlitz install crash (2026-09-04): `vitest@^4.1` peer metadata makes
      npm 10 (WebContainers) die with `Cannot read properties of null (reading
'edgesOut')`; npm 11 is fine. Examples pin `vitest: ^5.0.0`, which
      installs clean. Keep example devDependencies npm-10-safe: test a bumped
      example with `npx npm@10 install` outside the workspace before shipping.
- [x] Step 3 of the StackBlitz plan: `docs-check` prints a `drift N` column
      per page with an `example:` (checked fence lines not found in the
      example's `.ts`/`.tsx` files; imports, comments, `console.log`, `expect`
      and a leading `export ` ignored); `--drift` lists the lines. Warn-only,
      like the ratio. Deliberate drift today: chapter 2 (36), index (4),
      debounce (4), ecosystem (3), presence (2), chapter 3 (2).
