import { Effect } from "effect";
import { lexer, Parser, TextRenderer, type Token, type Tokens } from "marked";
import { allDocsEffect, decodeEntities, headingId, SECTIONS, type Doc } from "@/lib/docs";
import { run } from "@/lib/tracing";

/**
 * One searchable unit: a heading and the prose beneath it, up to the next
 * heading of any depth. The page's H1 (or the text before the first heading)
 * is the record with an empty `anchor`.
 */
export interface SearchRecord {
  /** `<slug>#<anchor>`; unique across the corpus. */
  readonly id: string;
  /** Route slug under `/docs/`: `""` for the index. */
  readonly slug: string;
  /** Section title for display (`Reference`), `""` for the index. */
  readonly section: string;
  readonly title: string;
  readonly heading: string;
  /** Element id on the rendered page; `""` for the top of the page. */
  readonly anchor: string;
  /** Plain text of the section, fenced code excluded. */
  readonly content: string;
}

/** Inline tokens flattened to their visible text; inline code kept, fences dropped elsewhere. */
const inlineText = (tokens: readonly Token[] | undefined): string => {
  if (!tokens) return "";
  return tokens
    .map((token) => {
      switch (token.type) {
        case "text":
        case "codespan":
        case "escape":
          return "tokens" in token && token.tokens ? inlineText(token.tokens) : token.text;
        case "link":
        case "strong":
        case "em":
        case "del":
        case "paragraph":
          return inlineText((token as Tokens.Link).tokens);
        case "br":
          return " ";
        case "image":
          return (token as Tokens.Image).text;
        default:
          return "";
      }
    })
    .join("");
};

/** Block tokens flattened to prose, fenced code and raw HTML dropped. */
const blockText = (token: Token): string => {
  switch (token.type) {
    case "code":
    case "space":
    case "hr":
    case "html":
    case "def":
      return "";
    case "list":
      return (token as Tokens.List).items.map(blockText).join(" ");
    case "list_item":
    case "blockquote":
      return (token as Tokens.ListItem).tokens.map(blockText).join(" ");
    case "table": {
      const t = token as Tokens.Table;
      return [...t.header, ...t.rows.flat()].map((cell) => inlineText(cell.tokens)).join(" ");
    }
    case "paragraph":
    case "text":
      return inlineText((token as Tokens.Paragraph).tokens ?? [token]);
    default:
      return "text" in token && typeof token.text === "string" ? token.text : "";
  }
};

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

const sectionTitle = (dir: string | undefined): string =>
  SECTIONS.find((s) => s.dir === dir)?.title ?? "";

/**
 * One doc split at its h1–h3 headings. Heading text and ids go through the
 * same functions the page renderer uses, so `anchor` is the id on the page.
 */
export const indexDoc = (doc: Doc): readonly SearchRecord[] => {
  const parser = new Parser();
  const textRenderer = new TextRenderer();
  const records: SearchRecord[] = [];
  const seen = new Map<string, number>();
  const section = sectionTitle(doc.section);
  let heading = doc.title;
  let anchor = "";
  let parts: string[] = [];

  const flush = () => {
    const content = collapse(parts.join(" "));
    parts = [];
    // A heading with nothing under it has nothing to find.
    if (content === "") return;
    records.push({
      id: `${doc.slug}#${anchor}`,
      slug: doc.slug,
      section,
      title: doc.title,
      heading,
      anchor,
      content,
    });
  };

  for (const token of lexer(doc.markdown)) {
    if (token.type === "heading") {
      const h = token as Tokens.Heading;
      // Deeper headings do not split the page, but they do get an id on
      // the page, so they must consume a slug to keep later ids aligned.
      const text = decodeEntities(parser.parseInline(h.tokens, textRenderer));
      const id = headingId(text, seen);
      if (h.depth > 3) {
        parts.push(text);
        continue;
      }
      // The H1 and any text before it are one record: the top of the page.
      if (h.depth !== 1) flush();
      heading = text;
      anchor = h.depth === 1 ? "" : id;
      continue;
    }
    parts.push(blockText(token));
  }
  flush();
  return records;
};

/** Every doc, in nav order, split into records. */
export const buildSearchIndexEffect = Effect.fn("search.index.build")(function* () {
  const docs = yield* allDocsEffect;
  const records = docs.flatMap(indexDoc);
  yield* Effect.annotateCurrentSpan("search.records", records.length);
  return records as readonly SearchRecord[];
});

export const buildSearchIndex = (): Promise<readonly SearchRecord[]> =>
  run(buildSearchIndexEffect());
