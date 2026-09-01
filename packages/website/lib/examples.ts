import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Project } from "@stackblitz/sdk";

/**
 * Runnable examples live next to the docs and ship in the library tarball.
 * Read from the workspace, like the docs themselves, so the site and the
 * package never disagree about what an example contains.
 */
const EXAMPLES_DIR = path.join(process.cwd(), "..", "react", "docs", "examples");
const LIBRARY_PACKAGE = path.join(EXAMPLES_DIR, "..", "..", "package.json");

/** Install output and editor droppings. Never part of a project payload. */
const SKIP = new Set(["node_modules", "dist", ".DS_Store"]);

export interface ExampleProject {
  readonly name: string;
  /** The payload `@stackblitz/sdk` posts to stackblitz.com. */
  readonly project: Project;
  /** The file StackBlitz opens first. */
  readonly openFile: string;
}

/** Relative file paths under `dir`, walking real directories only. */
const walk = async (dir: string, prefix = ""): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((e) => !SKIP.has(e.name))
      .map(async (e) => {
        const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
        if (e.isDirectory()) return walk(path.join(dir, e.name), rel);
        return e.isFile() ? [rel] : [];
      }),
  );
  return files.flat().sort();
};

let versionCache: Promise<string> | undefined;

/** The version of `@wych/react` this checkout is, read once. */
const libraryVersion = (): Promise<string> =>
  (versionCache ??= readFile(LIBRARY_PACKAGE, "utf8").then((text) => {
    const { version } = JSON.parse(text) as { version?: unknown };
    if (typeof version !== "string") throw new Error(`${LIBRARY_PACKAGE}: missing "version"`);
    return version;
  }));

/**
 * `workspace:^` is what the monorepo needs; StackBlitz installs from npm, so
 * the range is rewritten the way `pnpm publish` would rewrite it.
 */
const publishedRange = (spec: string, version: string): string => {
  if (!spec.startsWith("workspace:")) return spec;
  const range = spec.slice("workspace:".length);
  if (range === "^" || range === "~") return `${range}${version}`;
  if (range === "*" || range === "") return version;
  return range;
};

const rewritePackageJson = async (text: string): Promise<string> => {
  const pkg = JSON.parse(text) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const version = await libraryVersion();
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    if (deps === undefined) continue;
    for (const [name, spec] of Object.entries(deps)) deps[name] = publishedRange(spec, version);
  }
  return JSON.stringify(pkg, null, 2) + "\n";
};

/** The entry to show first: the mount, else the first test file, else the first source file. */
const pickOpenFile = (paths: readonly string[]): string =>
  paths.find((p) => p === "src/main.tsx") ??
  paths.find((p) => /^src\/.*\.test\.tsx?$/.test(p)) ??
  paths.find((p) => p.startsWith("src/")) ??
  paths[0]!;

/**
 * Build the StackBlitz project for `docs/examples/<name>`. Throws when the
 * directory is missing: an `example:` frontmatter that points nowhere is a
 * build error, not a silently absent button.
 */
export const loadExample = async (
  name: string,
  meta: { readonly title: string; readonly description: string },
): Promise<ExampleProject> => {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid example name: ${name}`);
  const dir = path.join(EXAMPLES_DIR, name);
  const paths = await walk(dir);
  if (paths.length === 0) throw new Error(`example "${name}" has no files under ${dir}`);

  const files: Record<string, string> = {};
  for (const rel of paths) {
    const text = await readFile(path.join(dir, rel), "utf8");
    // StackBlitz renders `README.md`; the tarball convention is lowercase.
    const key = rel === "readme.md" ? "README.md" : rel;
    files[key] = rel === "package.json" ? await rewritePackageJson(text) : text;
  }

  return {
    name,
    openFile: pickOpenFile(paths),
    project: {
      title: `@wych/react: ${meta.title}`,
      description: meta.description,
      template: "node",
      files,
    },
  };
};
