import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { Marked } from "marked";
import { createHighlighter } from "shiki";

/**
 * The docs live in the library package and ship inside its npm tarball, so this
 * site and `node_modules/@wych/react/docs` are always the same files. Resolved
 * from the workspace rather than copied: a copy step is a thing that drifts.
 */
const DOCS_DIR = path.join(process.cwd(), "..", "react", "docs");

/**
 * Diátaxis sections, in nav order. The directory a page lives in is its
 * section; `index.md` at the root is the landing page and belongs to none.
 */
export const SECTIONS = [
  { dir: "tutorial", title: "Tutorial" },
  { dir: "how-to", title: "How-to" },
  { dir: "reference", title: "Reference" },
  { dir: "explanation", title: "Explanation" },
] as const;

export type SectionDir = (typeof SECTIONS)[number]["dir"];

export interface Doc {
  /** Route slug under `/docs/`: `""` for the index, else `<section>/<name>`. */
  readonly slug: string;
  /** `undefined` for the index page. */
  readonly section: SectionDir | undefined;
  readonly title: string;
  readonly description: string;
  readonly order: number;
  /** The body, with frontmatter stripped. */
  readonly markdown: string;
}

const sectionRank = (section: SectionDir | undefined): number =>
  section === undefined ? -1 : SECTIONS.findIndex((s) => s.dir === section);

const isSection = (dir: string): dir is SectionDir => SECTIONS.some((s) => s.dir === dir);

/** `01-getting-started` reads in order on disk; the URL does not need the number. */
const stripOrderPrefix = (name: string): string => name.replace(/^\d+-/, "");

const parse = (file: string, raw: string): Doc | undefined => {
  const { data, content } = matter(raw);
  const dir = path.dirname(file);
  const name = path.basename(file, ".md");

  let slug: string;
  let section: SectionDir | undefined;
  if (dir === "." && name === "index") {
    slug = "";
    section = undefined;
  } else if (dir !== "." && isSection(dir)) {
    slug = `${dir}/${stripOrderPrefix(name)}`;
    section = dir;
  } else {
    // A page outside the four sections has no place in the nav; skip it
    // rather than guess.
    return undefined;
  }

  const prefix = /^(\d+)-/.exec(name)?.[1];
  return {
    slug,
    section,
    title: typeof data.title === "string" ? data.title : name,
    description: typeof data.description === "string" ? data.description : "",
    // `order` frontmatter wins, then a numeric filename prefix. Unordered pages
    // sort last rather than jumping to the front.
    order:
      typeof data.order === "number"
        ? data.order
        : prefix !== undefined
          ? Number(prefix)
          : Number.MAX_SAFE_INTEGER,
    markdown: content.trim(),
  };
};

let cached: Promise<readonly Doc[]> | undefined;

/** Every doc, in nav order: index first, then by section, then by `order`. */
export const allDocs = (): Promise<readonly Doc[]> =>
  (cached ??= (async () => {
    const entries = await readdir(DOCS_DIR, { recursive: true });
    const files = entries.filter((f) => f.endsWith(".md"));
    const docs = await Promise.all(
      files.map(async (f) => parse(f, await readFile(path.join(DOCS_DIR, f), "utf8"))),
    );
    return docs
      .filter((d): d is Doc => d !== undefined)
      .sort(
        (a, b) =>
          sectionRank(a.section) - sectionRank(b.section) ||
          a.order - b.order ||
          a.title.localeCompare(b.title),
      );
  })());

export const findDoc = async (slug: string): Promise<Doc | undefined> =>
  (await allDocs()).find((d) => d.slug === slug);

/** Docs grouped by section, in nav order. Empty sections are omitted. */
export const docsBySection = async (): Promise<
  ReadonlyArray<{ readonly title: string; readonly dir: SectionDir; readonly docs: readonly Doc[] }>
> => {
  const docs = await allDocs();
  return SECTIONS.map((s) => ({ ...s, docs: docs.filter((d) => d.section === s.dir) })).filter(
    (s) => s.docs.length > 0,
  );
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * One highlighter for the process. Creating one per page loads the grammars
 * again each time, which dominates the build.
 */
let highlighter: ReturnType<typeof createHighlighter> | undefined;

const marked = new Marked({
  async: true,
  gfm: true,
  async walkTokens(token) {
    if (token.type !== "code") return;
    const shiki = await (highlighter ??= createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: ["ts", "tsx", "js", "jsx", "json", "sh", "md"],
    }));
    const lang = token.lang?.split(/\s/)[0] ?? "";
    const known = shiki.getLoadedLanguages().includes(lang);
    // Shiki emits the `<pre>`; hand it through as raw HTML so marked does not
    // escape it again.
    const html = shiki.codeToHtml(token.text, {
      lang: known ? lang : "text",
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
    Object.assign(token, { type: "html", block: true, text: html });
  },
});

export const renderMarkdown = (markdown: string): Promise<string> =>
  marked.parse(markdown) as Promise<string>;
