# Wych

A feature runtime for React, built on [Effect](https://effect.website): pure
reducers, Effect commands, declared subscriptions, headless tests. Published
as [`@wych/react`](packages/react); documented at
[wych.build](https://wych.build).

- `packages/react`: the library, its docs (`docs/`, shipped in the tarball)
  and the runnable examples (`docs/examples/*`).
- `packages/website`: the docs site, reading the same `docs/` files.

## Development

A pnpm and Vite+ monorepo. Run commands from the repository root.

    vp install                              # after pulling
    vpr check                               # format, lint, type check, tstyche type tests
    vpr -r test                             # node, browser and docs-snippet tests, plus the examples
    vp -C packages/react run docs:check     # type-check doc fences, code ratios, internal links

The browser projects run in Playwright's Chromium. If the provider reports a
missing build, install it through the Playwright copy under
`node_modules/.pnpm/@vitest+browser-playwright*/node_modules/playwright`
(`node <that>/cli.js install chromium`); the root `playwright` fetches a
different build.

### Performance and resilience

Two on-demand suites, not part of `vpr -r test`:

    vp -C packages/react run bench            # tinybench, compared against packages/react/bench/baseline.json
    vp -C packages/react run bench:baseline   # rewrite the baseline after an intended change
    vp -C packages/react run stress           # node and browser stress suites
    vp -C packages/react run stress:node      # STRESS_SCALE=4 vp -C packages/react run stress:node for headroom
    vp -C packages/react run stress:browser

Run them after a change to `packages/react/src/lib.ts`, `devtools.ts` or
`utils/task.ts`, and before a release. The bench compare column is a prompt
to look, not a gate. Criteria, baseline numbers and open findings are in
`packages/react/src/lib.specs.md` under "Performance and resilience". A
defect the suites find is pinned as `it.fails` with a `HINT` comment naming
its spec entry; the fix is a separate change that flips the pin.

### Documentation

Docs follow Diátaxis under `packages/react/docs`. Prose is written by the
`wych-docs-author` agent (`.claude/agents/wych-docs-author.md`); `/document`
runs the full sweep for a change (`.claude/skills/document/SKILL.md`).
`AGENTS.md` holds the repository notes an agent reads first.

## License

MIT
