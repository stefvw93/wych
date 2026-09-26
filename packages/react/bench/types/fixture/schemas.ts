// The schemas a mid-sized feature carries: a deep item with URLs, dates and
// nested arrays, a paged payload of them, a params struct with a transforming
// codec, and one wide flat struct. The shapes, not the domain, are the point.
import { Schema, SchemaTransformation } from "effect";

export const Priority = Schema.Literals(["low", "normal", "high", "urgent"]);
export type Priority = typeof Priority.Type;

export const Status = Schema.Literals(["open", "doing", "blocked", "done"]);
export type Status = typeof Status.Type;

export const HexColor = Schema.String.check(Schema.isPattern(/^#(?:[0-9a-fA-F]{3}){1,2}$/));

export const Attachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.URLFromString,
  preview: Schema.optional(Schema.URLFromString),
  bytes: Schema.Number,
  mime: Schema.String,
  uploadedAt: Schema.DateFromString,
});

export const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  notes: Schema.optional(Schema.String),
  status: Status,
  priority: Priority,
  tags: Schema.Array(Schema.String),
  color: HexColor,
  link: Schema.optional(Schema.URLFromString),
  createdAt: Schema.DateFromString,
  dueAt: Schema.optional(Schema.DateFromString),
  completedAt: Schema.NullOr(Schema.DateFromString),
  estimate: Schema.Number,
  spent: Schema.Number,
  assignees: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  attachments: Schema.Array(Attachment),
});
export type Todo = typeof Todo.Type;

export const TodoPage = Schema.Struct({
  items: Schema.Array(Todo),
  meta: Schema.Struct({
    page: Schema.Number,
    pages: Schema.Number,
    perPage: Schema.Number,
    total: Schema.Number,
    query: Schema.NullOr(Schema.String),
  }),
});
export type TodoPage = typeof TodoPage.Type;

/** `"a,b,c"` (Encoded) <-> `["a", "b", "c"]` (Type). */
const CommaSeparated = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transform<ReadonlyArray<string>, string>({
      decode: (text) => (text === "" ? [] : text.split(",")),
      encode: (items) => items.join(","),
    }),
  ),
);

export const TodoFilter = Schema.Struct({
  q: Schema.optional(Schema.String),
  status: Schema.optional(Status),
  priority: Schema.optional(Priority),
  tags: Schema.optional(CommaSeparated),
  sort: Schema.optional(Schema.Literals(["created", "due", "priority", "title"])),
  order: Schema.optional(Schema.Literals(["asc", "desc"])),
  page: Schema.optional(Schema.NumberFromString),
});
export type TodoFilter = typeof TodoFilter.Type;

export const Density = Schema.Literals(["compact", "comfortable", "spacious"]);
export const Mode = Schema.Literals(["light", "dark"]);
export type Mode = typeof Mode.Type;

/** One wide, flat struct: a board's full appearance. */
export const Appearance = Schema.Struct({
  mode: Mode,
  density: Density,
  background: HexColor,
  surface: HexColor,
  surfaceRaised: HexColor,
  surfaceSunken: HexColor,
  border: HexColor,
  borderStrong: HexColor,
  text: HexColor,
  textMuted: HexColor,
  textInverse: HexColor,
  accent: HexColor,
  accentMuted: HexColor,
  danger: HexColor,
  warning: HexColor,
  success: HexColor,
  info: HexColor,
  focus: HexColor,
  token0: Schema.Number,
  token1: Schema.Number,
  token2: Schema.Number,
  token3: Schema.Number,
  token4: Schema.Number,
  token5: Schema.Number,
  token6: Schema.Number,
  token7: Schema.Number,
  token8: Schema.Number,
  token9: Schema.Number,
  token10: Schema.Number,
  token11: Schema.Number,
  token12: Schema.Number,
  token13: Schema.Number,
  token14: Schema.Number,
  token15: Schema.Number,
  token16: Schema.Number,
  token17: Schema.Number,
  token18: Schema.Number,
  token19: Schema.Number,
  token20: Schema.Number,
  token21: Schema.Number,
  token22: Schema.Number,
  token23: Schema.Number,
  token24: Schema.Number,
  token25: Schema.Number,
  token26: Schema.Number,
  token27: Schema.Number,
  token28: Schema.Number,
  token29: Schema.Number,
  token30: Schema.Number,
  token31: Schema.Number,
  token32: Schema.Number,
  token33: Schema.Number,
  token34: Schema.Number,
  token35: Schema.Number,
  token36: Schema.Number,
  token37: Schema.Number,
  token38: Schema.Number,
  token39: Schema.Number,
});
export type Appearance = typeof Appearance.Type;
