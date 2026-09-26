#!/usr/bin/env bash
# Interleaved A/B of the LSP bench: A is the library entry in $A (default: a
# `git archive HEAD` of src), B is the working tree. Rounds alternate so a
# drift in machine load hits both sides alike; the table is min over rounds
# of each scenario's median.
#
#   bench/types/ab.sh [rounds] [scenarios]
#   EXAMPLES=1 bench/types/ab.sh [rounds]   # the examples, one table each
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$(cd "$here/../.." && pwd)"
rounds="${1:-3}"
export SCENARIO="${2:-${SCENARIO:-}}"
export SAMPLES="${SAMPLES:-10}"
tmp="${BENCH_TMP:-$(mktemp -d)}"
if [[ -z "${A:-}" ]]; then
  base="$tmp/ab-base"
  rm -rf "$base" && mkdir -p "$base"
  git -C "$pkg" archive HEAD src | tar -x -C "$base"
  ln -sfn "$pkg/node_modules" "$base/node_modules"
  A="$base/src/index.ts"
fi
for ((i = 1; i <= rounds; i++)); do
  WYCH_ENTRY="$A" JSON="$tmp/ab-a-$i.json" node "$here/lsp-bench.mjs" >/dev/null 2>&1
  JSON="$tmp/ab-b-$i.json" node "$here/lsp-bench.mjs" >/dev/null 2>&1
done
node -e '
const fs = require("fs");
const [tmp, rounds] = [process.argv[1], +process.argv[2]];
const load = (s) => Array.from({ length: rounds }, (_, i) => JSON.parse(fs.readFileSync(`${tmp}/ab-${s}-${i + 1}.json`)));
const a = load("a"), b = load("b");
// One table for the fixture, or one per example file.
const tables = a[0].examples ? Object.keys(a[0].examples) : [undefined];
const pick = (run, name) => (name === undefined ? run.results : run.examples[name]);
for (const name of tables) {
  if (name !== undefined) console.log(`\n== ${name}`);
  const best = (runs, k) => Math.min(...runs.map((r) => pick(r, name)[k].median));
  console.log("scenario          A (base)   B (tree)     delta");
  for (const k of Object.keys(pick(a[0], name))) {
    const x = best(a, k), y = best(b, k);
    console.log(`${k.padEnd(16)} ${x.toFixed(1).padStart(8)}ms ${y.toFixed(1).padStart(8)}ms ${(((y - x) / x) * 100).toFixed(1).padStart(7)}%`);
  }
}' "$tmp" "$rounds"
