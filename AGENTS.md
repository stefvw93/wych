<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

## Project Notes

- pnpm + Vite+ monorepo. Packages live in `packages/*`; the library is
  `@wych/react` at `packages/react`. Root `package.json` is private.
- Root `vite.config.ts` owns repo-wide `lint`/`fmt` and `defaultPackage`
  (`./packages/react`), so bare `vp pack` / `vp build` target the library.
  Each package's `vite.config.ts` owns its Vitest, pack, and run tasks.
- Run commands from the repo root. `vpr check` = `vp check && vpr -r test:types`;
  `vpr test` fans out with `-r`. Plain `vp check` is the built-in and skips the
  tstyche type tests.
- To work on one package: `vp -C packages/react <command>`.
- `vp run test:types` runs tstyche over `src/**/*.tst.ts`; task defined in
  `packages/react/vite.config.ts` under `run.tasks`, cached.
- TypeScript: shared `compilerOptions` in root `tsconfig.base.json`; root
  `tsconfig.json` is a solution file referencing each package.

## Documentation

- Docs live at `packages/react/docs` and ship in the npm tarball; the site at
  `packages/website` reads them from the workspace. Layout is Diátaxis:
  `tutorial/`, `how-to/`, `reference/`, `explanation/`, with `index.md` as
  the map. Every page has `title`, `description`, `order` frontmatter.
- Prose docs are written by the `wych-docs-author` agent
  (`.claude/agents/wych-docs-author.md`); it holds the placement rules, model
  invariants for samples, and the prose style rules. `/document` runs the
  full docs sweep for a change (`.claude/skills/document/SKILL.md`).
- `vp -C packages/react run docs:check` type-checks every `ts`/`tsx` fence in
  the docs against `src/index.ts`, enforces a code ratio per section, and
  checks internal links. Run it after touching docs.
