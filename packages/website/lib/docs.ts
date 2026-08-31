import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { Marked } from "marked";
import { createHighlighter } from "shiki";

/**
 * The docs live in the library package and ship inside its npm tarball, so this
 * site and `node_modules/@wych/react/docs` are always the same files. Resolved
 * from the workspace rather than copied — a copy step is a thing that drifts.
 */
const DOCS_DIR = path.join(process.cwd(), "..", "react", "docs");

export interface Doc {
  /** Route slug: `index.md` is `""`, everything else is its basename. */
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly order: number;
  /** The body, with frontmatter stripped. */
  readonly markdown: string;
}

const parse = (file: string, raw: string): Doc => {
  const { data, content } = matter(raw);
  const name = path.basename(file, ".md");
  return {
    slug: name === "index" ? "" : name,
    title: typeof data.title === "string" ? data.title : name,
    description: typeof data.description === "string" ? data.description : "",
    // Unordered pages sort last rather than jumping to the front.
    order: typeof data.order === "number" ? data.order : Number.MAX_SAFE_INTEGER,
    markdown: content.trim(),
  };
};

let cached: Promise<readonly Doc[]> | undefined;

/** Every doc, in nav order. Read once per process — the files cannot change at runtime. */
export const allDocs = (): Promise<readonly Doc[]> =>
  (cached ??= (async () => {
    const files = (await readdir(DOCS_DIR)).filter((f) => f.endsWith(".md"));
    const docs = await Promise.all(
      files.map(async (f) => parse(f, await readFile(path.join(DOCS_DIR, f), "utf8"))),
    );
    return docs.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  })());

export const findDoc = async (slug: string): Promise<Doc | undefined> =>
  (await allDocs()).find((d) => d.slug === slug);

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
