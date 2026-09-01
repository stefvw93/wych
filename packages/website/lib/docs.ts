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
  /** Directory name under `docs/examples/` of the runnable project this page builds, if any. */
  readonly example: string | undefined;
  /** Path under `docs/`, for the edit link. */
  readonly file: string;
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
    example: typeof data.example === "string" ? data.example : undefined,
    file,
    markdown: content.trim(),
  };
};

let cached: Promise<readonly Doc[]> | undefined;

/**
 * Every doc, in nav order: index first, then by section, then by `order`.
 * Memoized for the build only: in `next dev` the module outlives the file
 * set, and a page added after the server started would 404 forever.
 */
export const allDocs = (): Promise<readonly Doc[]> => {
  if (process.env.NODE_ENV !== "production") return readDocs();
  return (cached ??= readDocs());
};

const readDocs = (): Promise<readonly Doc[]> =>
  (async () => {
    // Only the index and the four sections are pages. `docs/examples/*` are
    // runnable projects with their own `node_modules`, so a recursive walk
    // from `docs/` is never safe.
    const files = [
      "index.md",
      ...(
        await Promise.all(
          SECTIONS.map(async (s) =>
            (await readdir(path.join(DOCS_DIR, s.dir)))
              .filter((f) => f.endsWith(".md"))
              .map((f) => `${s.dir}/${f}`),
          ),
        )
      ).flat(),
    ];
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
  })();

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

/**
 * GitHub-style heading slug: lowercase, punctuation dropped, spaces to
 * hyphens. `seen` dedupes repeats on one page the way GitHub does (`-1`, `-2`).
 */
const headingId = (text: string, seen: Map<string, number>): string => {
  const base =
    text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-") || "section";
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
};

export interface Heading {
  readonly id: string;
  readonly text: string;
  readonly depth: 2 | 3;
}

export interface Rendered {
  readonly html: string;
  /** `h2` and `h3` in document order, for the on-page nav. */
  readonly headings: readonly Heading[];
}

/** marked hands heading text through its HTML escaper; the outline wants the characters back. */
const decodeEntities = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const escapeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Copy button injected into every code block; `CopyCode` wires the click. */
const COPY_BUTTON =
  `<button type="button" data-copy-code aria-label="Copy code" ` +
  `class="group/copy absolute top-2 right-2 inline-flex size-7 items-center justify-center border border-border bg-background/80 text-muted-foreground opacity-0 backdrop-blur transition-opacity group-hover/code:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50 data-copied:text-primary data-copied:opacity-100">` +
  `<svg class="size-3.5 group-data-copied/copy:hidden" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>` +
  `<svg class="hidden size-3.5 group-data-copied/copy:block" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/></svg>` +
  `</button>`;

/**
 * A parser per render: the heading renderer keeps per-page state (the slugs
 * it has issued and the outline), and Next renders pages in parallel, so a
 * shared instance would leak between pages.
 */
const createMarked = (headings: Heading[]) => {
  const seen = new Map<string, number>();
  return new Marked({
    async: true,
    gfm: true,
    renderer: {
      // Every heading is a link to itself. The `#` sits in the left margin and
      // shows on hover or keyboard focus; `scroll-mt` clears the sticky header.
      heading({ tokens, depth }) {
        const text = decodeEntities(this.parser.parseInline(tokens, this.parser.textRenderer));
        const id = headingId(text, seen);
        if (depth === 2 || depth === 3) headings.push({ id, text, depth });
        const inner = this.parser.parseInline(tokens);
        return (
          `<h${depth} id="${id}" class="group relative scroll-mt-20">` +
          `<a href="#${id}" class="no-underline before:absolute before:-left-[1.25em] before:text-muted-foreground before:opacity-0 before:transition-opacity before:content-['#'] group-hover:before:opacity-100 focus-visible:outline-none focus-visible:before:opacity-100">` +
          `${inner}</a></h${depth}>\n`
        );
      },
      // Off-site links leave the docs in a new tab; everything else falls
      // through to the default renderer.
      link({ href, title, tokens }) {
        if (!/^https?:\/\//.test(href)) return false;
        const t = title ? ` title="${escapeAttr(title)}"` : "";
        return `<a href="${escapeAttr(href)}"${t} target="_blank" rel="noreferrer">${this.parser.parseInline(tokens)}</a>`;
      },
    },
    async walkTokens(token) {
      if (token.type !== "code") return;
      const shiki = await (highlighter ??= createHighlighter({
        themes: ["github-light", "github-dark"],
        langs: ["ts", "tsx", "js", "jsx", "json", "sh", "md"],
      }));
      const lang = token.lang?.split(/\s/)[0] ?? "";
      const known = shiki.getLoadedLanguages().includes(lang);
      // Shiki emits the `<pre>`; hand it through as raw HTML so marked does not
      // escape it again. The wrapper hosts the copy button.
      const html = shiki.codeToHtml(token.text, {
        lang: known ? lang : "text",
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: false,
      });
      Object.assign(token, {
        type: "html",
        block: true,
        text: `<div class="group/code relative">${html}${COPY_BUTTON}</div>\n`,
      });
    },
  });
};

export const renderMarkdown = async (markdown: string): Promise<Rendered> => {
  const headings: Heading[] = [];
  const html = await createMarked(headings).parse(markdown);
  // A wide table scrolls inside its own box instead of the page. Shiki
  // escapes `<` inside code, so this only matches real tables.
  return {
    html: html
      .replace(/<table>/g, '<div class="overflow-x-auto"><table>')
      .replace(/<\/table>/g, "</table></div>"),
    headings,
  };
};
