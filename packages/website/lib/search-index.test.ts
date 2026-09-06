import { expect, test } from "vite-plus/test";
import type { Doc } from "@/lib/docs";
import { indexDoc } from "@/lib/search-index";

const doc = (markdown: string, overrides: Partial<Doc> = {}): Doc => ({
  slug: "reference/commands",
  section: "reference",
  title: "Commands",
  description: "",
  order: 1,
  example: undefined,
  file: "reference/commands.md",
  markdown,
  ...overrides,
});

test("the H1 and the prose under it are one record with no anchor", () => {
  const records = indexDoc(doc("# Commands\n\nA command is data.\n"));
  expect(records).toEqual([
    {
      id: "reference/commands#",
      slug: "reference/commands",
      section: "Reference",
      title: "Commands",
      heading: "Commands",
      anchor: "",
      content: "A command is data.",
    },
  ]);
});

test("h2 and h3 split the page; anchors match the page renderer", () => {
  const records = indexDoc(
    doc(
      "# Commands\n\nIntro.\n\n## `Command.restart`\n\nTake latest.\n\n### Group\n\nOne namespace.\n",
    ),
  );
  expect(records.map((r) => [r.heading, r.anchor, r.content])).toEqual([
    ["Commands", "", "Intro."],
    ["Command.restart", "commandrestart", "Take latest."],
    ["Group", "group", "One namespace."],
  ]);
});

test("fenced code is dropped, inline code and list text are kept", () => {
  const [record] = indexDoc(
    doc("# T\n\nCall `restart` here.\n\n```ts\nconst secret = 1;\n```\n\n- one\n- two\n\n> note\n"),
  );
  expect(record?.content).toBe("Call restart here. one two note");
  expect(record?.content).not.toContain("secret");
});

test("a repeated heading takes the -1 suffix, like the rendered page", () => {
  const records = indexDoc(doc("# T\n\n## Run\n\nA.\n\n## Run\n\nB.\n"));
  expect(records.map((r) => r.anchor)).toEqual(["run", "run-1"]);
  expect(new Set(records.map((r) => r.id)).size).toBe(2);
});

test("an h4 folds into its section but still consumes a slug", () => {
  const records = indexDoc(doc("# T\n\n## Run\n\nA.\n\n#### Run\n\nDeep.\n\n## Run\n\nB.\n"));
  expect(records.map((r) => [r.anchor, r.content])).toEqual([
    ["run", "A. Run Deep."],
    ["run-2", "B."],
  ]);
});

test("a heading with nothing under it is not a record", () => {
  const records = indexDoc(doc("# T\n\n## Empty\n\n## Full\n\nText.\n"));
  expect(records.map((r) => r.heading)).toEqual(["Full"]);
});

test("the index page has an empty section and a bare slug", () => {
  const [record] = indexDoc(
    doc("# Overview\n\nHello.\n", { slug: "", section: undefined, title: "Overview" }),
  );
  expect(record).toMatchObject({ id: "#", slug: "", section: "" });
});
