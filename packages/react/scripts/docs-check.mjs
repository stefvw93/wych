/**
 * Checks the docs under `docs/`:
 *
 * 1. Every `ts`/`tsx` fence type-checks against `src/index.ts`. A fence tagged
 *    `ts continue` is appended to the page's previous checked fence, so a page
 *    can build one file step by step. A fence tagged `ts fragment` is skipped;
 *    use it only for a snippet the page has already shown in full.
 * 2. Every page's code ratio (code lines over non-blank lines) is printed
 *    against its section's suggested floor: tutorial and how-to 50%,
 *    reference 40%, explanation 25%. A page below the floor is flagged in the
 *    table and never fails the check; the number is a prompt to look, not a
 *    gate.
 * 3. Every `/docs/...` link resolves to a page.
 * 4. With `--run`, every checked snippet is executed in a browser (the `docs`
 *    vitest project). Each `console.log(expr);` followed by `// => literal`
 *    becomes `expect(expr).toEqual(literal)`, so a result comment that drifts
 *    from the real behaviour fails. A statement followed by `// throws Name: msg`
 *    is wrapped in `expect(() => { ... }).toThrow("msg")`. A `// =>` literal
 *    may continue over following `//` lines until its brackets balance.
 *    `toEqual` compares structurally, so a literal for a command value fails
 *    on the command's `pipe` method: log `summarizeCommand(cmd)` or
 *    `cmd?._tag` instead of the command itself.
 * 5. A page with `example:` frontmatter is compared against
 *    `docs/examples/<name>`: every code line of a checked fence (imports,
 *    comments, `console.log` and `expect` lines aside, a leading `export `
 *    ignored) should appear in one of the example's source files. The count
 *    of lines that do not is printed as `drift` and never fails the check.
 *
 * Fences import `test`/`expect` from `"vitest"` as a reader would; the
 * checker rewrites that specifier to `"vite-plus/test"`, which is the module
 * the `docs` vitest project resolves.
 *
 * Run: `vp run docs:check` from `packages/react`. `--section <dir>` checks one
 * section only (links still resolve against every page) and writes its
 * generated files under `.docs-check/<dir>`, so sections can run in parallel.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.join(root, "docs");
const shouldRun = process.argv.includes("--run");
const sectionArg = process.argv.indexOf("--section");
const section = sectionArg === -1 ? undefined : process.argv[sectionArg + 1];
const outDir = path.join(root, ".docs-check", section ?? "all");

const TARGETS = { tutorial: 0.5, "how-to": 0.5, reference: 0.4, explanation: 0.25 };

/** Readers write `from "vitest"`; the `docs` project resolves `vite-plus/test`. */
const withTestSpecifier = (line) => line.replace(/from\s*"vitest"/, 'from "vite-plus/test"');

/**
 * Trimmed source lines of every `.ts`/`.tsx` file under an example, for the
 * drift count. `node_modules` is a pnpm symlink farm and is never walked.
 */
const exampleLines = (name) => {
  const lines = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        for (const line of readFileSync(full, "utf8").split("\n")) {
          const trimmed = line.trim();
          lines.add(trimmed);
          // A page shows `const x`, an example exports it.
          lines.add(trimmed.replace(/^export /, ""));
        }
      }
    }
  };
  walk(path.join(docsDir, "examples", name));
  return lines;
};

/** A fence line the drift count compares; `undefined` for a line it skips. */
const driftKey = (line) => {
  const s = line.trim().replace(/^export /, "");
  if (s === "" || /^(\/\/|import\b|\} from\b|console\.log\(|expect\()/.test(s)) return undefined;
  if (/^[{}()[\];,]*$/.test(s)) return undefined;
  return s;
};

// Only the index and the four sections are pages. `docs/examples/*` are
// runnable projects with their own `node_modules`, so a recursive walk from
// `docs/` is never safe.
const pages = [
  "index.md",
  ...Object.keys(TARGETS).flatMap((dir) =>
    readdirSync(path.join(docsDir, dir))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => `${dir}/${f}`),
  ),
].map((rel) => {
  const text = readFileSync(path.join(docsDir, rel), "utf8");
  const dir = path.dirname(rel);
  const name = path.basename(rel, ".md").replace(/^\d+-/, "");
  const slug = dir === "." ? (name === "index" ? "" : name) : `${dir}/${name}`;
  return { rel, dir, slug, text };
});

const slugs = new Set(pages.map((p) => p.slug));
const checked = section === undefined ? pages : pages.filter((p) => p.dir === section);
const failures = [];

// --- extract fences --------------------------------------------------------

// A full run owns the whole directory, so stale per-section output cannot
// linger and run under `vp test`.
rmSync(section === undefined ? path.join(root, ".docs-check") : outDir, {
  recursive: true,
  force: true,
});
mkdirSync(outDir, { recursive: true });

/**
 * One generated file per checked unit. `segments` maps generated line ranges
 * back to the page, so a `continue` fence reports errors at its own lines.
 * @type {Array<{ file: string; rel: string; segments: Array<{ genStart: number; srcStart: number; length: number }>; lines: string[] }>}
 */
const generated = [];

for (const page of checked) {
  const lines = page.text.split("\n");
  let fence = null;
  let code = 0;
  let prose = 0;
  let inFrontmatter = false;
  let block = 0;
  /** The unit a `continue` fence appends to. */
  let current = null;
  /** Raw lines of every checked fence, for the drift count. */
  const driftLines = [];

  lines.forEach((line, i) => {
    if (i === 0 && line === "---") {
      inFrontmatter = true;
      return;
    }
    if (inFrontmatter) {
      if (line === "---") inFrontmatter = false;
      return;
    }
    const open = /^```(\S*)\s*(.*)$/.exec(line);
    if (fence === null && open) {
      fence = { lang: open[1], info: open[2], start: i + 1, body: [] };
      return;
    }
    if (fence !== null && line.startsWith("```")) {
      block += 1;
      const checkable =
        (fence.lang === "ts" || fence.lang === "tsx") && !/\bfragment\b/.test(fence.info);
      if (checkable) {
        const continues = /\bcontinue\b/.test(fence.info) && current !== null;
        if (!continues) {
          const file = path.join(
            outDir,
            `${page.slug.replace(/\//g, "__") || "index"}__${block}.tsx`,
          );
          current = { file, rel: page.rel, segments: [], lines: [] };
          generated.push(current);
        }
        current.segments.push({
          genStart: current.lines.length + 1,
          srcStart: fence.start + 1,
          length: fence.body.length,
        });
        current.lines.push(...fence.body.map(withTestSpecifier));
        driftLines.push(...fence.body);
      }
      fence = null;
      return;
    }
    if (fence !== null) {
      fence.body.push(line);
      code += 1;
      return;
    }
    if (line.trim() !== "") {
      prose += 1;
      for (const m of line.matchAll(/\]\(\/docs\/?([^)#]*)(#[^)]*)?\)/g)) {
        if (!slugs.has(m[1])) failures.push(`${page.rel}:${i + 1}: broken link /docs/${m[1]}`);
      }
    }
  });

  const target = TARGETS[page.dir];
  const ratio = code / Math.max(1, code + prose);
  const pct = Math.round(ratio * 100);
  const status =
    target === undefined ? "" : ratio >= target ? "ok" : `below ${target * 100}% (suggestion)`;
  const example = /^example:\s*(\S+)\s*$/m.exec(page.text)?.[1];
  let drift = "";
  let driftReport = [];
  if (example !== undefined) {
    const known = exampleLines(example);
    const missing = driftLines.map(driftKey).filter((k) => k !== undefined && !known.has(k));
    drift = `  drift ${String(missing.length).padStart(3)}`;
    if (process.argv.includes("--drift")) driftReport = missing;
  }
  console.log(
    `${page.rel.padEnd(40)} code ${String(code).padStart(4)} prose ${String(prose).padStart(4)}  ${String(pct).padStart(3)}%  ${status.padEnd(4)}${drift}`,
  );
  for (const k of driftReport) console.log(`    ${k}`);
}

for (const unit of generated) writeFileSync(unit.file, unit.lines.join("\n") + "\n");

// --- type-check ------------------------------------------------------------

writeFileSync(
  path.join(outDir, "tsconfig.json"),
  JSON.stringify(
    {
      extends: path.relative(outDir, path.join(root, "..", "..", "tsconfig.base.json")),
      compilerOptions: {
        noUnusedLocals: false,
        noEmit: true,
        paths: { "@wych/react": [path.relative(outDir, path.join(root, "src", "index.ts"))] },
      },
      include: ["./*.tsx"],
    },
    null,
    2,
  ),
);

if (generated.length > 0) {
  const tscBin = path.join(root, "..", "..", "node_modules", ".bin", "tsc");
  const tsc = spawnSync(tscBin, ["-p", path.join(outDir, "tsconfig.json"), "--pretty", "false"], {
    cwd: root,
    encoding: "utf8",
  });
  if (tsc.error) failures.push(`tsc failed to start: ${tsc.error.message}`);
  const byFile = new Map(generated.map((g) => [g.file, g]));
  let parsed = 0;
  for (const line of (tsc.stdout + tsc.stderr).split("\n")) {
    const m = /^(.+?)\((\d+),(\d+)\): (.*)$/.exec(line);
    if (!m) {
      // A config-level error (TS5083 and friends) has no file position.
      if (/error TS\d+/.test(line)) failures.push(line);
      continue;
    }
    const gen = byFile.get(path.resolve(root, m[1]));
    if (gen === undefined) {
      failures.push(line);
      continue;
    }
    parsed += 1;
    const genLine = Number(m[2]);
    const seg =
      gen.segments.find((s) => genLine >= s.genStart && genLine < s.genStart + s.length) ??
      gen.segments[0];
    failures.push(`${gen.rel}:${seg.srcStart + genLine - seg.genStart}:${m[3]}: ${m[4]}`);
  }
  if (tsc.status !== 0 && parsed === 0 && !tsc.error) {
    failures.push(`tsc exited ${tsc.status}:\n${tsc.stdout}${tsc.stderr}`);
  }
}

// --- run -------------------------------------------------------------------

/**
 * `console.log(expr);` + `// => literal` on the next line becomes an equality
 * assertion. A statement (possibly multi-line, ending in `;`) followed by
 * `// throws Name: message` is wrapped in a `toThrow` assertion. The statement
 * starts after the previous line that ends a statement (`;`) or is blank.
 */
const toAssertions = (source) => {
  const lines = joinResultComments(source)
    .replace(
      /^([ \t]*)console\.log\((.+)\);\n[ \t]*\/\/ => (.+)$/gm,
      (_m, indent, expr, literal) => `${indent}expect(${expr}).toEqual(${literal});`,
    )
    .split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^[ \t]*\/\/ throws\b\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let start = i - 1;
    while (start > 0) {
      const prev = lines[start - 1];
      if (prev.trim() === "" || /;\s*$/.test(prev)) break;
      start -= 1;
    }
    const message = m[1].replace(/^\w*Error:\s*/, "");
    const wrapped = [
      "expect(() => {",
      ...lines.slice(start, i),
      `}).toThrow(${message === "" ? "" : JSON.stringify(message)});`,
    ];
    lines.splice(start, i - start + 1, ...wrapped);
    i = start + wrapped.length - 1;
  }
  return lines.join("\n");
};

/** Bracket depth of a literal, string contents ignored. */
const depth = (text) => {
  const bare = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
  return (bare.match(/[[{(]/g)?.length ?? 0) - (bare.match(/[\]})]/g)?.length ?? 0);
};

/**
 * A `// =>` literal that spans several `//` lines is joined into one, so the
 * `console.log` rewrite sees a single line. Continuation stops when the
 * brackets balance.
 */
const joinResultComments = (source) => {
  const lines = source.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([ \t]*)\/\/ => (.*)$/.exec(lines[i]);
    if (!m) {
      out.push(lines[i]);
      continue;
    }
    let literal = m[2];
    while (depth(literal) > 0 && i + 1 < lines.length) {
      const next = /^[ \t]*\/\/ ?(.*)$/.exec(lines[i + 1]);
      if (!next || next[1].startsWith("=>")) break;
      literal += ` ${next[1].trim()}`;
      i += 1;
    }
    out.push(`${m[1]}// => ${literal}`);
  }
  return out.join("\n");
};

/** A snippet that is itself a vitest file runs as one; wrapping it would nest tests. */
const isTestFile = (source) =>
  /import\s*\{[^}]*\b(test|it|describe)\b[^}]*\}\s*from\s*"vite-plus\/test"/.test(source);

/** Snippets that import `expect` themselves keep their own import. */
const withExpect = (source) =>
  /import\s*\{[^}]*\bexpect\b[^}]*\}\s*from\s*"vite-plus\/test"/.test(source)
    ? source
    : `import { expect } from "vite-plus/test";\n${source}`;

if (shouldRun && failures.length === 0 && generated.length > 0) {
  const runDir = path.join(outDir, "run");
  mkdirSync(runDir, { recursive: true });
  for (const unit of generated) {
    const base = path.basename(unit.file, ".tsx");
    const source = unit.lines.join("\n");
    if (isTestFile(source)) {
      writeFileSync(path.join(runDir, `${base}.docs.test.tsx`), `${toAssertions(source)}\n`);
      continue;
    }
    writeFileSync(path.join(runDir, `${base}.run.tsx`), `${withExpect(toAssertions(source))}\n`);
    writeFileSync(
      path.join(runDir, `${base}.docs.test.tsx`),
      [
        `import { test } from "vite-plus/test";`,
        ``,
        `test(${JSON.stringify(unit.rel)}, async () => {`,
        `  document.body.innerHTML = '<div id="root"></div>';`,
        `  await import("./${base}.run.tsx");`,
        `});`,
        ``,
      ].join("\n"),
    );
  }
  // `vitest` has no bin in this workspace (it is overridden by Vite+), so the
  // snippets run through the `vp test` built-in.
  const run = spawnSync("vp", ["test", "--project", "docs", path.relative(root, runDir)], {
    cwd: root,
    encoding: "utf8",
  });
  if (run.error !== undefined) {
    failures.push(`snippet execution could not start: ${run.error.message}`);
  } else if (run.status !== 0) {
    failures.push(`snippet execution failed:\n${run.stdout}\n${run.stderr}`);
  } else {
    console.log(`${generated.length} snippets executed`);
  }
}

console.log(`\n${generated.length} snippets type-checked, ${checked.length} pages`);
if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("docs ok");
