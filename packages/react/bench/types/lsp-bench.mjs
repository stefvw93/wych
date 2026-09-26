// Language-server latency for the editor paths a Wych user hits most:
// reducer handler keys (completion, hover, exhaustiveness) and the handler
// snapshot (`draft`, `tasks`). Drives the TypeScript 7 language server
// (`tsc --lsp --stdio`) over ./fixture/todos.tsx, a mid-sized feature, or
// over the runnable examples in docs/examples.
//
// Every sample is taken on a fresh document version: the server builds a new
// program per edit, so the measured request pays for the checker work a
// keystroke costs, not a cached answer.
//
//   node bench/types/lsp-bench.mjs                # library source (default)
//   WYCH_TYPES=dist node bench/types/lsp-bench.mjs  # the built .d.ts
//   SAMPLES=30 SCENARIO=complete-key node bench/types/lsp-bench.mjs
//   JSON=out.json node bench/types/lsp-bench.mjs  # write the results
//   WYCH_ENTRY=/other/checkout/src/index.ts node bench/types/lsp-bench.mjs  # A/B against another tree
//   FIXTURE=/some/dir node bench/types/lsp-bench.mjs  # another fixture (see scale.mjs)
//   EXAMPLES=1 node bench/types/lsp-bench.mjs     # every example file with a reducer
//   PPROF_DIR=/tmp/prof node bench/types/lsp-bench.mjs  # the server's CPU profile (go tool pprof)
//   AUTO_IMPORTS=1 node bench/types/lsp-bench.mjs  # keep the server's auto-import indexing on
//
// Auto-import indexing is off by default: the server builds that index of
// every package's exports in the background, on its own schedule, and a
// build that overlaps the timed requests can add 20 percent or more to one
// side of an A/B with no type change behind it.
//
// Against an app instead (in place, edits stay in memory):
//   TARGET_DIR=/path/to/app TARGET_FILE=src/features/todos/index.tsx \
//   TARGET_MARKERS='{"hoverDraft":"{ state, ‸draft"}' node bench/types/lsp-bench.mjs
// Each marker maps to a search string with a ‸ where the marker sits.
// A scenario whose marker is not found is skipped.

import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../..");
const repo = resolve(pkg, "../..");
const tsc = process.env.TSC ?? join(repo, "node_modules/.bin/tsc");

const SAMPLES = Number(process.env.SAMPLES ?? 15);
const WARMUP = 2;
const ONLY = process.env.SCENARIO;
const TYPES = process.env.WYCH_TYPES === "dist" ? "dist" : "src";
const ENTRY =
  process.env.WYCH_ENTRY ??
  (TYPES === "dist" ? join(pkg, "dist/index.d.ts") : join(pkg, "src/index.ts"));

// ---------------------------------------------------------------------------
// Markers: each mode reduces to a map of marker name to offset in the file.
// ---------------------------------------------------------------------------

/** `/*@name*\/` comments in the fixture; the formatter puts a space after one. */
const commentMarkers = (text) => {
  const offsets = {};
  for (const match of text.matchAll(/\/\*@(\w+)\*\/ */g)) {
    offsets[match[1]] = match.index + match[0].length;
  }
  return offsets;
};

/** `‸` search strings, for an app measured in place. */
const searchMarkers = (text, markers) => {
  const offsets = {};
  for (const [name, tag] of Object.entries(markers)) {
    const index = text.indexOf(tag.replace("‸", ""));
    if (index >= 0) offsets[name] = index + tag.indexOf("‸");
  }
  return offsets;
};

/**
 * Found in an example by its shape: the first reducer object, its first
 * handler key, the first snapshot that destructures `draft` or `tasks`, and
 * the first member access on either. What an example does not have is left
 * out, and its scenario skipped.
 */
const shapeMarkers = (text) => {
  const offsets = {};
  // The `const` keyword itself: a hover with no type behind it, the fresh
  // version's own cost. A declared name might be a message or a feature.
  const constant = /^(?:export )?const \w/m.exec(text);
  if (constant) offsets.control = constant.index + constant[0].indexOf("const");
  const reducer = /reducer(?:: \{|\(\{)\n( *)/.exec(text);
  if (!reducer) return offsets;
  const from = reducer.index + reducer[0].length;
  offsets.newKey = from;
  const rest = text.slice(from);
  const at = (pattern, group) => {
    const match = pattern.exec(rest);
    return match ? from + match.index + match[0].indexOf(group) : undefined;
  };
  offsets.hoverKey = at(/^ *[A-Z]\w*:/m, rest.match(/^ *([A-Z]\w*):/m)?.[1] ?? "");
  const handler = /\{([^{}()]*)\}\) =>/g;
  for (const match of rest.matchAll(handler)) {
    const inner = match[1];
    const base = from + match.index + 1;
    if (offsets.hoverDraft === undefined && /\bdraft\b/.test(inner)) {
      offsets.hoverDraft = base + inner.search(/\bdraft\b/);
    }
    if (offsets.hoverTasks === undefined && /\btasks\b/.test(inner)) {
      offsets.hoverTasks = base + inner.search(/\btasks\b/);
    }
  }
  offsets.draftDot = at(/\bdraft\.\w/, "draft");
  offsets.tasksDot = at(/\btasks\.\w/, "tasks");
  return Object.fromEntries(Object.entries(offsets).filter(([, value]) => value !== undefined));
};

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * Text and cursor for a marker. `insert` goes in at the marker; `dot` first
 * removes the member access there (`draft.mode`), so `insert` replaces it.
 */
const at = (base, offsets, marker, { insert = "", dot = false, cursorOffset = 0 } = {}) => {
  const start = offsets[marker];
  if (start === undefined) return undefined;
  const replace = dot ? (/^\w+\.\w+/.exec(base.slice(start))?.[0].length ?? 0) : 0;
  const text = base.slice(0, start) + insert + base.slice(start + replace);
  return { text, offset: start + insert.length + cursorOffset };
};

const hover = (marker) => (base, offsets) => {
  const made = at(base, offsets, marker, { cursorOffset: 2 });
  return made && { ...made, method: "textDocument/hover" };
};

const scenarios = {
  // Control: hover over a plain local with no Wych type in it. What any
  // request costs on a fresh version; the rest of the table is read against it.
  control: hover("control"),
  // The dependency chain a reducer request resolves, one link per hover:
  // each pays for the links before it, so the step between two rows is the
  // cost of that link. The fixture marks them; an example does not.
  "chain-state": hover("chainState"),
  "chain-task": hover("chainTask"),
  "chain-task-gen": hover("chainTaskGen"),
  "chain-actions": hover("chainActions"),
  "chain-define": hover("chainDefine"),
  "chain-reducer": hover("chainReducer"),
  "chain-component": hover("chainComponent"),
  // Pull diagnostics for the whole file: the exhaustiveness and return checks.
  diagnostics: (base, offsets) => {
    const made = at(base, offsets, "newKey");
    return made && { ...made, method: "textDocument/diagnostic" };
  },
  // Typing a new handler key: `Se|` at the top of the reducer object.
  "complete-key": (base, offsets) => {
    const made = at(base, offsets, "newKey", { insert: "Se" });
    return made && { ...made, method: "textDocument/completion" };
  },
  // Hover over an existing handler key.
  "hover-key": hover("hoverKey"),
  // Hover over the destructured snapshot members.
  "hover-draft": hover("hoverDraft"),
  "hover-tasks": hover("hoverTasks"),
  // Member completion on the snapshot: `draft.|` and `tasks.|`.
  "complete-draft": (base, offsets) => {
    const made = at(base, offsets, "draftDot", { insert: "draft.", dot: true });
    return made && { ...made, method: "textDocument/completion" };
  },
  "complete-tasks": (base, offsets) => {
    const made = at(base, offsets, "tasksDot", { insert: "tasks.", dot: true });
    return made && { ...made, method: "textDocument/completion" };
  },
};

// ---------------------------------------------------------------------------
// A minimal LSP client, one server per measured file
// ---------------------------------------------------------------------------

const openServer = async (work) => {
  // Go's collector pauses land on random samples and split the timings into
  // two modes. Off, with a memory limit so it still runs before the server
  // takes the machine: a few collections per run instead of one every few
  // requests.
  const server = spawn(
    tsc,
    ["--lsp", "--stdio", ...(process.env.PPROF_DIR ? ["--pprofDir", process.env.PPROF_DIR] : [])],
    {
      cwd: work,
      stdio: ["pipe", "pipe", "pipe"],
      env: { GOGC: "off", GOMEMLIMIT: "3GiB", ...process.env },
    },
  );
  // The server logs "context canceled" when it exits; anything else is worth seeing.
  server.stderr.on("data", (chunk) => {
    const text = chunk.toString().replace(/^.*context canceled.*\n?/gm, "");
    if (text) process.stderr.write(text);
  });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();

  const send = (message) => {
    const body = JSON.stringify(message);
    server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  server.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(
        /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1],
      );
      if (buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
      buffer = buffer.subarray(headerEnd + 4 + length);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.id !== undefined && message.method) {
        // A server-to-client request (configuration, registration): answer empty.
        send({
          jsonrpc: "2.0",
          id: message.id,
          result:
            message.method === "workspace/configuration"
              ? message.params.items.map(() => null)
              : null,
        });
      }
    }
  });

  const request = (method, params) =>
    new Promise((resolveRequest) => {
      const id = nextId++;
      pending.set(id, resolveRequest);
      send({ jsonrpc: "2.0", id, method, params });
    });
  const notify = (method, params) =>
    send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });

  await request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(work).href,
    workspaceFolders: [{ uri: pathToFileURL(work).href, name: "bench" }],
    capabilities: {
      textDocument: {
        hover: { contentFormat: ["markdown", "plaintext"] },
        completion: { completionItem: { snippetSupport: false } },
        diagnostic: {},
      },
    },
  });
  notify("initialized", {});
  // The server indexes every package's exports for auto-import completions,
  // in the background and on its own schedule. That work lands on random
  // samples and has nothing to do with the types under test, so it is off
  // unless `AUTO_IMPORTS=1` asks for the editor's full behaviour.
  if (!process.env.AUTO_IMPORTS) {
    const preferences = {
      includeCompletionsForModuleExports: false,
      autoImportFileExcludePatterns: ["**/node_modules/**"],
    };
    notify("workspace/didChangeConfiguration", {
      settings: {
        typescript: { preferences },
        javascript: { preferences },
        "js/ts": { preferences },
      },
    });
  }

  return {
    request,
    notify,
    close: async () => {
      await request("shutdown", null);
      // Let it exit on its own first: a profile (`PPROF_DIR`) is written on the way out.
      const exited = new Promise((resolveExit) => server.once("exit", resolveExit));
      notify("exit");
      const timeout = setTimeout(() => server.kill(), 10_000);
      await exited;
      clearTimeout(timeout);
    },
  };
};

// ---------------------------------------------------------------------------
// Measuring one file
// ---------------------------------------------------------------------------

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Position (line, character) of `offset` in `text`. */
const position = (text, offset) => {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: offset - before.lastIndexOf("\n") - 1 };
};

const describe = (method, response) => {
  if (response.error) return `error: ${response.error.message}`;
  const result = response.result;
  if (method === "textDocument/diagnostic") return `${result?.items?.length ?? 0} diagnostics`;
  if (method === "textDocument/completion") {
    const items = Array.isArray(result) ? result : (result?.items ?? []);
    return `${items.length} items`;
  }
  if (method === "textDocument/hover") {
    const value = result?.contents?.value ?? JSON.stringify(result?.contents ?? "");
    return `${value.length} chars`;
  }
  return "";
};

const benchFile = async (work, file, markersOf) => {
  const uri = pathToFileURL(file).href;
  const base = readFileSync(file, "utf8");
  const offsets = markersOf(base);
  const lsp = await openServer(work);
  let version = 1;
  lsp.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "typescriptreact", version, text: base },
  });
  // Let the project load before the first sample.
  await lsp.request("textDocument/diagnostic", { textDocument: { uri } });

  const results = {};
  for (const [name, make] of Object.entries(scenarios)) {
    if (ONLY && !ONLY.split(",").includes(name)) continue;
    const made = make(base, offsets);
    if (made === undefined) continue;
    const { text, offset, method } = made;
    const times = [];
    let last;
    for (let i = 0; i < WARMUP + SAMPLES; i++) {
      // A trailing comment that changes every sample: a new version, the same program shape.
      lsp.notify("textDocument/didChange", {
        textDocument: { uri, version: ++version },
        contentChanges: [{ text: `${text}\n// ${i}\n` }],
      });
      const started = performance.now();
      last = await lsp.request(method, {
        textDocument: { uri },
        ...(method === "textDocument/diagnostic" ? {} : { position: position(text, offset) }),
      });
      if (i >= WARMUP) times.push(performance.now() - started);
    }
    const summary = describe(method, last);
    results[name] = {
      median: median(times),
      min: Math.min(...times),
      max: Math.max(...times),
      summary,
    };
    console.log(
      `${name.padEnd(16)} median ${results[name].median.toFixed(1).padStart(7)}ms  min ${results[name].min.toFixed(1).padStart(7)}ms  max ${results[name].max.toFixed(1).padStart(7)}ms  ${summary}`,
    );
  }
  await lsp.close();
  return results;
};

/**
 * A scratch copy of `source` with the fixture's tsconfig, so `@wych/react`
 * can point at src, dist or another tree and edits never touch the repo.
 */
const scratch = (source) => {
  const work = mkdtempSync(join(process.env.BENCH_TMP ?? tmpdir(), "wych-lsp-bench-"));
  cpSync(source, work, { recursive: true });
  const tsconfig = readFileSync(join(here, "fixture/tsconfig.json"), "utf8").replace(
    /"@wych\/react": \[[^\]]*\]/,
    `"@wych/react": [${JSON.stringify(ENTRY)}]`,
  );
  writeFileSync(join(work, "tsconfig.json"), tsconfig);
  // Imports resolve from the package's node_modules: effect, react and the
  // example dependencies are all dev dependencies of the package.
  if (!existsSync(join(work, "node_modules"))) {
    symlinkSync(join(pkg, "node_modules"), join(work, "node_modules"));
  }
  return work;
};

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

const output = { types: TYPES, samples: SAMPLES };

if (process.env.TARGET_DIR) {
  const markers = JSON.parse(process.env.TARGET_MARKERS ?? "{}");
  const work = process.env.TARGET_DIR;
  output.results = await benchFile(work, join(work, process.env.TARGET_FILE), (text) =>
    searchMarkers(text, markers),
  );
} else if (process.env.EXAMPLES) {
  const examples = join(pkg, "docs/examples");
  output.examples = {};
  for (const example of readdirSync(examples).sort()) {
    const src = join(examples, example, "src");
    if (!existsSync(src)) continue;
    const files = readdirSync(src)
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .filter((name) => /reducer(?:: \{|\(\{)\n/.test(readFileSync(join(src, name), "utf8")));
    if (files.length === 0) continue;
    const work = scratch(src);
    for (const name of files) {
      const key = relative(examples, join(src, name));
      console.log(`\n== ${key}`);
      output.examples[key] = await benchFile(work, join(work, name), shapeMarkers);
    }
    rmSync(work, { recursive: true, force: true });
  }
} else {
  const work = scratch(process.env.FIXTURE ?? join(here, "fixture"));
  const file = readdirSync(work).find((name) => name.endsWith(".tsx"));
  console.log(`== ${basename(file)}`);
  output.results = await benchFile(work, join(work, file), commentMarkers);
  rmSync(work, { recursive: true, force: true });
}

if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify(output, null, 2));
