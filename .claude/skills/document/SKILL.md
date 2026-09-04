---
name: "document"
description: "Documentation sweep for a change to @wych/react. Use after code is reviewed and green: JSDoc on changed exports, *.specs.md sync, docs/ pages, package README, example readme.md files. Prose docs are written by the wych-docs-author agent; JSDoc and specs sync by the main thread. Hard gate: the change is not complete until docs are complete."
---

# /document: Documentation sweep

Bring all documentation touched by the change up to date. A change is not complete until this step completes.

## When to run

- After the code change is reviewed and `vpr check` and `vpr test` are green.
- Before committing or opening a PR for that change.

## Scope: everything touched by the change

1. **JSDoc** on all new/changed exported functions, types, and values. Self-evident exports get exactly one line; doc blocks ≤ 3 lines for typical functions; no `@example` unless usage isn't inferable from the signature/name; no em-dashes. Omit `@type` annotations; describe non-obvious parameters; annotate Effect Schemas when not self-explanatory.
2. **`*.specs.md` sync**: the co-located spec (`src/lib.specs.md`, `src/devtools.specs.md`, `src/utils/task.specs.md`) must reflect final behavior. Acceptance criteria, skip records, and edge cases must match reality.
3. **`docs/` pages and the package README**: update or create when the public API surface changed. `packages/react/docs` follows the Diátaxis framework (`tutorial/`, `how-to/`, `reference/`, `explanation/`; `index.md` is the map). Each page fits exactly one mode; the `wych-docs-author` agent carries the placement rules and frontmatter requirements.
4. **Example `readme.md`** for every touched `examples/*` package, once that directory exists. Must contain the required sections: Overview, Problem, Solution, How It Works, When to Use.

## Authorship split

- **Prose documentation** (`docs/` pages, package README, example readmes, conceptual guides): spawn the **`wych-docs-author`** agent (defined in `.claude/agents/wych-docs-author.md`). Give it the relevant `*.specs.md` path, the changed files, and the doc targets. It grounds itself in source before writing and never documents unverified APIs.
- **JSDoc + `*.specs.md` sync:** done by the main thread directly (it holds the implementation context).
- **Fallback:** if the agent is unavailable, the main thread writes the prose docs itself following the rules in `.claude/agents/wych-docs-author.md`.

## Procedure

1. Inventory the diff: list changed exports, public-API changes, touched docs pages, touched examples.
2. Main thread: verify/complete JSDoc; sync `*.specs.md`.
3. Spawn `wych-docs-author` for the prose targets from the inventory; review its output against the source (no invented APIs, no broken model invariants, correct quadrant, frontmatter present).
4. Run `vp -C packages/react run docs:check`: type-checks every `ts`/`tsx` fence in `docs/` against the library, enforces the code ratio per section, and checks `/docs/...` links. Must be green.
5. Run `vpr check` from the repo root: formats and lints the JSDoc and markdown. Must be green.
6. Build the docs site once (`vp -C packages/website run build`) when a page was added, moved or renamed, so a broken slug or link fails here, before deploy.

## Rules

- Documentation is a hard gate: a feature without its docs sweep is not committable.
- All prose follows the Communication Style rules in `.claude/agents/wych-docs-author.md` (STE100, sentence length cap, no em-dashes, paragraph cadence, banned vocabulary, bullets over long prose lists).
- Docs must match the source: every claim verifiable, code samples follow Oxfmt conventions (two spaces, double quotes) and Effect v4 idioms, no sample breaks a model invariant.
- Effect code in docs and examples uses `Effect.gen(function* () { ... })` for anything with more than one step; `.pipe(...)` only for a single trailing combinator. It reads imperatively, which is what the audience needs.
