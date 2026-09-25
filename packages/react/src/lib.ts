import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Context as ReactContext,
  type FC,
  type ReactNode,
} from "react";
import {
  Cause,
  Context,
  Effect,
  Equivalence,
  Exit,
  Fiber,
  identity,
  Layer,
  ManagedRuntime,
  Option,
  Pipeable,
  Queue,
  Schema,
  SchemaIssue,
  SchemaParser,
} from "effect";
import {
  Devtools,
  noopDevtools,
  summarizeCommand,
  summarizeDefect,
  type DevtoolsCause,
  type DevtoolsEvent,
  type DevtoolsSink,
} from "./devtools";
import {
  closeDraft,
  Drafter,
  mutativeDrafter,
  openDraft,
  type Draft,
  type DraftHandle,
  type DrafterService,
} from "./draft";

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Collapse a type to a flat object literal, for hovers.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The tags the runtime raises, reserved so a declared action cannot take one.
 */
export type LifecycleTag = "Mounted" | "PropsChanged" | "Error" | "Unmounted" | "HookChanged";

/** Guard for one tag, at `Action`. */
export type NotLifecycleTag<Tag extends string> = Tag extends LifecycleTag ? never : unknown;

/**
 * The runtime counterpart of `LifecycleTag`, kept exhaustive by the compiler:
 * a `Record` literal missing (or misspelling) a key fails to satisfy the
 * `Record<LifecycleTag, true>` annotation.
 */
const LifecycleTags: Record<LifecycleTag, true> = {
  Mounted: true,
  PropsChanged: true,
  Error: true,
  Unmounted: true,
  HookChanged: true,
};

/**
 * Checks if a tag is a lifecycle tag.
 */
const isLifecycleTag = (tag: string): tag is LifecycleTag => Object.hasOwn(LifecycleTags, tag);

const handlerFor = <Handler>(
  handlers: Record<string, Handler>,
  tag: string,
): Handler | undefined => (Object.hasOwn(handlers, tag) ? handlers[tag] : undefined);

const channel: unique symbol = Symbol("@wych/channel");
export type Channel = "internal" | "outbound";

/**
 * `make()` for a message whose fields are all optional, so an empty payload
 * is not spelled `make({})`. Absent when a field is required.
 */
type EmptyMake<S extends Schema.Top> = {} extends S["~type.make.in"]
  ? { make(input?: S["~type.make.in"], options?: Schema.MakeOptions): S["Type"] }
  : {};

export type Message<
  Tag extends Capitalize<string>,
  Fields extends Schema.Struct.Fields,
  Ch extends Channel,
> = Schema.TaggedStruct<Tag, Fields> & { readonly [channel]: Ch } & EmptyMake<
    Schema.TaggedStruct<Tag, Fields>
  >;

/**
 * A record of messages declared at once, each keyed by its own tag: what
 * `Action({ … })` returns.
 */
export type Messages<Defs extends Record<string, Schema.Struct.Fields>, Ch extends Channel> = {
  readonly [K in keyof Defs & string]: Message<K & Capitalize<string>, Defs[K], Ch>;
};

/**
 * The record form's key check, surfaced as an error string on the offending
 * key: a tag is capitalized and is not one the runtime raises.
 */
export type ValidTags<Defs> = {
  readonly [K in keyof Defs]: K extends LifecycleTag
    ? `"${K & string}" is a reserved lifecycle tag`
    : K extends Capitalize<string>
      ? unknown
      : `"${K & string}" must be capitalized`;
};

export type AnyMessage<Ch extends Channel> = Schema.Codec<any, any> & {
  readonly Type: { readonly _tag: string };
  readonly [channel]: Ch;
};

const members: unique symbol = Symbol("@wych/members");

/** Anything carrying a channel brand: the least a carried member has to show. */
type Branded<Ch extends Channel> = { readonly [channel]: Ch };

/**
 * @internal A value that declares messages without being one: a `Task`
 * operation carries its two actions this way, so it goes into a slot as is.
 */
export interface MemberCarrier<M extends ReadonlyArray<Branded<Channel>>> {
  readonly [members]: M;
}

/** @internal Brand `value` as carrying `list`. */
export const carryMembers = <T extends object, const M extends ReadonlyArray<Branded<Channel>>>(
  value: T,
  list: M,
): T & MemberCarrier<M> => Object.assign(value, { [members]: list });

const taskBinding: unique symbol = Symbol("@wych/task");

/**
 * @internal What `define`'s `tasks` slot reads off a `Task` operation: its
 * two tags, its commands and the values its field moves through. The type
 * parameters are the field's type, the success type, the two actions, the
 * `run` input (`never` for an operation that takes the effect), the
 * services and the channel.
 *
 * Declared here and filled by `Task`, so this module reads an operation
 * without importing the module that makes one.
 */
export interface TaskBinding<Field, Success, A, Input, R, Ch extends Channel> {
  readonly channel: Ch;
  readonly resolvedTag: string;
  readonly rejectedTag: string;
  /** `mode: "first"`: a `start` while the field is `Pending` does nothing. */
  readonly first: boolean;
  readonly schema: Schema.Top;
  readonly run: (input: Input) => Command<A, R>;
  readonly cancel: Command<A>;
  readonly idle: Field;
  readonly pending: Field;
  readonly resolved: (value: Success) => Field;
  readonly rejected: (error: unknown) => Field;
}

/** @internal A value carrying a {@link TaskBinding}: every `Task` operation. */
export interface TaskCarrier<B> {
  readonly [taskBinding]: B;
}

/** @internal Brand `value` with the binding `define`'s `tasks` slot reads. */
export const bindTask = <T extends object, B>(value: T, binding: B): T & TaskCarrier<B> =>
  Object.assign(value, { [taskBinding]: binding });

/**
 * What `define`'s `tasks` slot takes under each key: an internal `Task`
 * operation. `Task.output` is refused by the channel, since an announced
 * operation's actions never reach the fold that would write its field.
 *
 * `never` in the input position: a bound operation's `run` takes its input,
 * and a function over `never` is the one every such signature is
 * assignable to.
 */
export type AnyTaskOperation = TaskCarrier<TaskBinding<any, any, any, never, any, "internal">>;

/** The `tasks` slot: field key to operation. */
export type TaskSlots = { readonly [key: string]: AnyTaskOperation };

type BindingOf<T> = T extends TaskCarrier<infer B> ? B : never;

type FieldOfBinding<B> = B extends TaskBinding<infer F, any, any, never, any, Channel> ? F : never;

type ActionOfBinding<B> =
  B extends TaskBinding<any, any, infer A extends Tagged, never, any, Channel> ? A : never;

/** The state fields a `tasks` slot adds: one `TaskValue` per key. */
export type TaskFields<TS> = {
  readonly [K in keyof TS]: FieldOfBinding<BindingOf<TS[K]>>;
};

/** The actions a `tasks` slot adds: each operation's `Resolved` and `Rejected`. */
export type TaskActionsOf<TS> = ActionOfBinding<BindingOf<TS[keyof TS]>>;

/** `State` with the slot's fields, or `State` itself for a feature with no tasks. */
export type WithTasks<State, TS> = [keyof TS] extends [never]
  ? State
  : Simplify<State & TaskFields<TS>>;

/** What `initialState` returns: the state without the slot's fields, which start `Idle`. */
export type InitialStateOf<State, TS> = [keyof TS] extends [never] ? State : Omit<State, keyof TS>;

/**
 * One slot task, as `snapshot.tasks.<key>` hands it to a reducer handler.
 * Both methods write the field into `snapshot.draft` and return the draft
 * beside the operation's command, so the call is the handler's return, or
 * the draft is written further before it is returned.
 *
 * `start` takes what the operation's `run` takes: its input, or the effect
 * for an operation declared without `run`. The command carries the
 * operation's `R`, so `ServicesOf` reads it off the handler's return.
 */
export type TaskHandle<B, D> =
  B extends TaskBinding<any, infer S, infer A, infer I, infer R, Channel>
    ? {
        /**
         * Write `Pending` and issue the work. Under `mode: "first"`, a start
         * while the field is `Pending` writes nothing and issues
         * `Command.none`.
         */
        readonly start: [I] extends [never]
          ? <V extends S, E = never, R2 = never>(
              effect: Effect.Effect<V, E, R2>,
            ) => readonly [D, Command<A, R2>]
          : (input: I) => readonly [D, Command<A, R>];

        /** Write `Idle` and interrupt the work in flight. */
        readonly cancel: () => readonly [D, Command<A>];
      }
    : never;

/** `snapshot.tasks`: one {@link TaskHandle} per key of the `tasks` slot. */
export type TaskHandles<TS, State> = {
  readonly [K in keyof TS]: TaskHandle<BindingOf<TS[K]>, Draft<State>>;
};

/** A task key may not name a field the state schema already declares. */
export type NoTaskCollision<StateSchema extends AnyStateSchema, TS> = [
  Extract<keyof TS, keyof StateOf<StateSchema>>,
] extends [never]
  ? unknown
  : never;

/**
 * Two keys may not share tags, which is what one operation under two keys
 * looks like to the types. `never` lands on each offending key.
 */
export type NoDuplicateTaskTags<TS> = {
  readonly [K in keyof TS]: [
    Extract<TaskActionsOf<Pick<TS, K>>["_tag"], TaskActionsOf<Omit<TS, K>>["_tag"]>,
  ] extends [never]
    ? unknown
    : never;
};

/** One source that is not an array: a message, a `Task`, or a record of messages. */
export type MemberLeaf<Ch extends Channel> =
  | AnyMessage<Ch>
  | MemberCarrier<ReadonlyArray<Branded<Ch>>>
  | { readonly [tag: string]: AnyMessage<Ch> };

/**
 * What `define`'s `actions` and `outputs` slots take: a message, a record of
 * messages (`Action({ … })`), a `Task` operation, or an array of those, one
 * array deep inside another at most. `Ch` is the slot's channel, so an
 * outbound message in the `actions` slot is a compile error.
 *
 * The depth is bounded because `MemberOf` recurses over it: over a recursive
 * constraint it would never bottom out.
 */
export type MemberSource<Ch extends Channel> =
  | MemberLeaf<Ch>
  | ReadonlyArray<MemberLeaf<Ch> | ReadonlyArray<MemberLeaf<Ch>>>;

/**
 * The message values a source declares, as a union. Reads the channel brand
 * rather than matching `AnyMessage`: a structural check against a schema is
 * deep, and this recurses.
 */
export type MemberOf<S> = S extends { readonly [channel]: Channel; readonly Type: infer T }
  ? T
  : S extends { readonly [members]: infer M extends ReadonlyArray<unknown> }
    ? MemberOf<M[number]>
    : S extends ReadonlyArray<infer E>
      ? MemberOf<E>
      : S extends object
        ? MemberOf<S[keyof S]>
        : never;

/** The message values a source declares, known to be tagged. */
export type MembersOf<S> = Extract<MemberOf<S>, Tagged>;

/** The tags a source declares. */
export type TagsOf<S> = MembersOf<S>["_tag"];

/** A message value: what the vocabulary types below are written against. */
export type Tagged = { readonly _tag: string };

export interface MessageConstructor<Ch extends Channel> {
  /** One message. `fields` is optional: `Action("Reverted")` carries no payload. */
  <const Tag extends Capitalize<string>, const Fields extends Schema.Struct.Fields = {}>(
    tag: Tag & NotLifecycleTag<Tag>,
    fields?: Fields,
  ): Message<Tag, Fields, Ch>;

  /**
   * Several messages, each tag written once as a key:
   *
   *     const actions = Action({ Typed: { query: Schema.String }, Cleared: {} })
   *     dispatch(actions.Typed, { query })
   */
  <const Defs extends Record<string, Schema.Struct.Fields>>(
    defs: Defs & ValidTags<Defs>,
  ): Messages<Defs, Ch>;
}

export interface Vocabularies extends MessageConstructor<"internal"> {
  /**
   * Announced, never handled here. An output has no reducer handler. Its tag is
   * not in the reducer's key set, and it is not in `dispatch`'s union, so it
   * cannot be sent by hand.
   *
   * Delivered as one `on<Tag>` prop per output — see `OutputProps`.
   */
  readonly output: MessageConstructor<"outbound">;
}

/** The tag a message was declared with, read by `define` without decoding the schema. */
const messageTag: unique symbol = Symbol("@wych/tag");

const message = (ch: Channel, tag: string, fields: Schema.Struct.Fields = {}) => {
  const schema = Schema.TaggedStruct(tag, fields);
  const make = schema.make.bind(schema);
  return Object.assign(schema, {
    [channel]: ch,
    [messageTag]: tag,
    make: (input?: object, options?: Schema.MakeOptions) => make((input ?? {}) as never, options),
  });
};

export const messages = (ch: Channel) =>
  function messages(
    tagOrDefs: string | Record<string, Schema.Struct.Fields>,
    fields?: Schema.Struct.Fields,
  ) {
    if (typeof tagOrDefs === "string") return message(ch, tagOrDefs, fields);
    return Object.freeze(
      Object.fromEntries(
        Object.keys(tagOrDefs).map((tag) => [tag, message(ch, tag, tagOrDefs[tag])]),
      ),
    );
  };

/**
 * Declared vocabularies. `Action(…)` is handled here and never seen outside;
 * `Action.output(…)` is the reverse.
 */
export const Action = Object.assign(messages("internal"), {
  output: messages("outbound"),
}) as Vocabularies;

/** An action tag and an output tag may not coincide. */
export type Disjoint<A extends Tagged, O extends Tagged> = [Extract<A["_tag"], O["_tag"]>] extends [
  never,
]
  ? unknown
  : never;

/**
 * What a command may emit.
 */
export type Emit<A extends Tagged, O extends Tagged> = A | O;

export type AnyStateSchema = Schema.Struct<any>;

export type StateOf<S extends AnyStateSchema> = S["Type"];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type AnyPropsSchema = Schema.Struct<Schema.Struct.Fields>;

export type PropsOf<P extends AnyPropsSchema> = P["Type"];

/**
 * Marks a prop the devtools must not print. The annotation's value is the
 * placeholder printed in its stead.
 */
const OPAQUE = "@wych/opaque";

/** One declaration, at whatever type the feature calls its children. */
const children = <T>(): Schema.declare<T> =>
  Schema.declare<T>((_u): _u is T => true, {
    identifier: "Children",
    [OPAQUE]: "<children>",
    toEquivalence: () => () => true,
  });

/**
 * Whatever a feature accepts as `children` — a node, a render prop, a tuple of
 * slots. **The type argument is the contract**; the schema carries no
 * structure at all.
 *
 *     children: Children                                    // ReactNode
 *     children: Children.as<(row: Row) => ReactNode>()      // a render prop
 *     children: Schema.optionalKey(Children)                // optional
 *
 * Three deliberate properties: it **validates anything** (React owns what it
 * can render; the type argument holds callers to the contract); it is
 * **invisible to change detection** (equivalence constantly `true`, so a fresh
 * node per parent render never raises `PropsChanged` — the corollary is that a
 * reducer's `snapshot.props.children` can be stale; `render` always sees the
 * current one); and it is **redacted in devtools** to `"<children>"`, keeping
 * every event JSON round-trippable.
 *
 * Declared plainly the key is **required** — JSX passing no children omits the
 * key rather than passing `undefined`, so the optional form is
 * `Schema.optionalKey`.
 */
export const Children: Schema.declare<ReactNode> & {
  /** The same declaration at another children type — a render prop, say. */
  readonly as: <T>() => Schema.declare<T>;
} = Object.assign(children<ReactNode>(), { as: children });

/**
 * The props carrying an `OPAQUE` annotation, paired with their placeholder.
 *
 * Read off the field's own AST, and — because `Schema.optional(x)` is
 * `optionalKey(UndefinedOr(x))` — off a union's members. `Schema.optionalKey`
 * needs no unwrapping: it marks the key, leaving the declaration's AST intact.
 */
/** Renders a schema issue with every problem and its path, for props defects. */
const formatIssue = SchemaIssue.makeFormatterDefault();

const opaqueProps = (schema: AnyPropsSchema): ReadonlyArray<readonly [string, unknown]> => {
  const found: Array<readonly [string, unknown]> = [];

  for (const [key, field] of Object.entries(schema.fields)) {
    const ast = field.ast;
    const placeholder =
      ast.annotations?.[OPAQUE] ??
      ("types" in ast && Array.isArray(ast.types)
        ? ast.types.find((member: { annotations?: Record<string, unknown> }) =>
            Object.hasOwn(member.annotations ?? {}, OPAQUE),
          )?.annotations?.[OPAQUE]
        : undefined);

    if (placeholder !== undefined) found.push([key, placeholder]);
  }

  return found;
};

// ---------------------------------------------------------------------------
// Outputs, as props
// ---------------------------------------------------------------------------

/**
 * One `on<Tag>` prop per declared output, derived from the union.
 *
 * `_tag` is stripped from the payload, since the prop name already carries it —
 * `onOrderPlaced={({ orderId }) => …}` rather than destructuring around a
 * discriminant nobody needs to read.
 *
 * Degrades to `{}` when a feature declares no outputs.
 */
export type OutputProps<Output extends { readonly _tag: string }> = {
  readonly [K in Output["_tag"] as `on${K}`]: (
    payload: Simplify<Omit<Extract<Output, { readonly _tag: K }>, "_tag">>,
  ) => void;
};

export type NoPropCollision<PropsSchema extends AnyPropsSchema, O extends Tagged> = [
  Extract<keyof PropsOf<PropsSchema>, `on${O["_tag"]}`>,
] extends [never]
  ? unknown
  : never;

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * Two tuple patterns rather than `infer C` then `C extends …`: a naked `C`
 * would distribute over `Command`'s own union, and the `None` member — which
 * mentions no `R` — infers `unknown` and swallows the rest.
 */
type ServiceOf<T> = T extends readonly [any, Command<any, infer R>]
  ? R
  : T extends readonly [any, LazyCommand<any, any, infer R>]
    ? R
    : never;

export type ServicesOf<U> = {
  [K in keyof U]: ServiceOf<ReturnType<Extract<U[K], (...args: any) => any>>>;
}[keyof U];

// ---------------------------------------------------------------------------
// Member sources, at runtime
// ---------------------------------------------------------------------------

/** Every message a `MemberSource` declares, in declaration order. */
const flattenMembers = (
  source: unknown,
  out: Array<AnyMessage<Channel>> = [],
): Array<AnyMessage<Channel>> => {
  // First: a message schema is a function carrying properties, which the
  // record branch would otherwise walk.
  if (isMessage(source)) out.push(source);
  else if (Array.isArray(source)) for (const member of source) flattenMembers(member, out);
  else if (typeof source === "object" && source !== null && Object.hasOwn(source, members))
    flattenMembers((source as MemberCarrier<ReadonlyArray<Branded<Channel>>>)[members], out);
  else if (typeof source === "object" && source !== null)
    for (const member of Object.values(source)) flattenMembers(member, out);
  else
    throw new TypeError(
      `define: ${String(source)} is not a message, a record of messages, a Task, or an array of those`,
    );
  return out;
};

/** The tags of a slot, checked against its channel and against every tag seen so far. */
const tagsIn = (
  source: unknown,
  expected: Channel,
  slot: "actions" | "outputs",
  seen: Set<string>,
): Array<string> =>
  flattenMembers(source).map((member) => {
    const tag = (member as unknown as { readonly [messageTag]: string })[messageTag];
    if (member[channel] !== expected)
      throw new TypeError(
        `define: "${tag}" is ${member[channel]} and cannot be declared in "${slot}"`,
      );
    if (seen.has(tag)) throw new TypeError(`define: tag "${tag}" is declared twice`);
    seen.add(tag);
    return tag;
  });

/**
 * The `tasks` slot, checked: every value is an internal `Task` operation,
 * no key is a state field, no operation sits under two keys, and no tag is
 * one `seen` already holds from `actions` and `outputs`. The types hold
 * each of these where they can see it; this holds them for a slot that got
 * past the types.
 */
const slotTasks = (
  spec: { readonly state: AnyStateSchema; readonly tasks?: Readonly<Record<string, unknown>> },
  seen: Set<string>,
): ReadonlyArray<SlotTask> => {
  const tasks = spec.tasks;
  if (tasks === undefined) return [];
  const declared = new Set(seen);
  const keyOf = new Map<unknown, string>();
  return Object.keys(tasks).map((key) => {
    const operation = tasks[key];
    if (
      typeof operation !== "object" ||
      operation === null ||
      !Object.hasOwn(operation, taskBinding)
    ) {
      throw new TypeError(`define: tasks.${key} is not a Task operation`);
    }
    const binding = (operation as TaskCarrier<SlotTask["binding"]>)[taskBinding];
    if (binding.channel !== "internal") {
      throw new TypeError(
        `define: tasks.${key} is a Task.output operation; its actions never reach the fold that would write the field`,
      );
    }
    if (Object.hasOwn(spec.state.fields, key)) {
      throw new TypeError(`define: tasks.${key} is also a field of the state schema`);
    }
    const other = keyOf.get(operation);
    if (other !== undefined) {
      throw new TypeError(`define: one Task operation is under two keys, "${other}" and "${key}"`);
    }
    keyOf.set(operation, key);
    for (const tag of [binding.resolvedTag, binding.rejectedTag]) {
      if (declared.has(tag)) {
        throw new TypeError(
          `define: tag "${tag}" of tasks.${key} is also declared in "actions" or "outputs"`,
        );
      }
      if (seen.has(tag)) throw new TypeError(`define: tag "${tag}" is declared twice`);
      seen.add(tag);
    }
    return { key, binding };
  });
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * A message schema whose values `A` admits: what `dispatch(Message, payload)`
 * takes in place of a built message. `MessageOf<never>` admits nothing.
 */
export type MessageOf<A> = AnyMessage<Channel> & { readonly Type: A };

/** What `M.make` takes, without `_tag`: the payload of a message schema. */
export type PayloadOf<M extends Schema.Top> = Simplify<Omit<M["~type.make.in"], "_tag">>;

/** The payload argument, optional exactly when every field is. */
export type PayloadArgs<M extends Schema.Top> =
  {} extends PayloadOf<M> ? [payload?: PayloadOf<M>] : [payload: PayloadOf<M>];

/**
 * Where a command's emissions go. Takes a built message, or a message schema
 * and its payload: `dispatch(Loaded, { hits })` is `dispatch(Loaded.make({ hits }))`,
 * and `dispatch(Cleared)` needs no payload.
 *
 * The value form is the last overload, so an inference that reads one
 * signature off `dispatch` passed as a callback (`Stream.runForEach(s, dispatch)`)
 * reads that one.
 */
export interface Dispatcher<A> {
  <M extends MessageOf<A>>(message: M, ...payload: PayloadArgs<M>): Effect.Effect<void>;
  (action: A): Effect.Effect<void>;
}

/** Whether `value` is a message schema rather than a built message. */
const isMessage = (value: unknown): value is AnyMessage<Channel> =>
  typeof value === "function" && Object.hasOwn(value, channel);

/**
 * Build the message a two-argument call names. `make` validates, so a bad
 * payload throws here: a defect of the command or subscription that sent it,
 * or out of the event handler that called `render`'s `dispatch`.
 */
const toMessage = (message: unknown, payload: unknown): { readonly _tag: string } =>
  isMessage(message)
    ? (message as unknown as { make: (input: unknown) => { readonly _tag: string } }).make(payload)
    : (message as { readonly _tag: string });

/** A `Dispatcher` over `emit`, taking either form. */
const toDispatcher = (
  emit: (message: { readonly _tag: string }) => Effect.Effect<void>,
): Dispatcher<any> =>
  ((message: unknown, payload?: unknown) =>
    isMessage(message)
      ? Effect.suspend(() => emit(toMessage(message, payload)))
      : emit(message as { readonly _tag: string })) as Dispatcher<any>;

/**
 * The nominal marker that keeps a {@link Subscription} out of a `Next` tuple
 * and a {@link Command} out of a subscriptions record. Structurally the one
 * subscription variant *is* the command's `Effect` variant, so without it
 * either would slide into the other's slot unnoticed. A subscription carries
 * the key; a command forbids it.
 */
const subscription: unique symbol = Symbol("@wych/subscription");

/**
 * The async work a state change kicks off.
 */
export type Command<A, R = never> = Pipeable.Pipeable & {
  readonly [subscription]?: never;
} &
  /** Explicit no-op, for when a bare `state` return reads worse. */
  (
    | { readonly _tag: "None" }

    /**
     * The leaf. Runs for effects, and emits by calling `dispatch` — zero times,
     * once, or forever. A command that emits nothing simply ignores the
     * parameter, which is why there is no separate "effect that cannot emit"
     * variant: it is this one with an unused argument.
     */
    | {
        readonly _tag: "Effect";
        readonly effect: (dispatch: Dispatcher<A>) => Effect.Effect<unknown, never, R>;
      }

    /**
     * Names the fiber this command forks, so `Cancel` can address it. Nothing
     * else: it does not interrupt, defer, or serialise anything. Nesting
     * resolves outermost-first, matching the wrapper it replaced.
     */
    | { readonly _tag: "Keyed"; readonly key: string; readonly command: Command<A, R> }

    /**
     * Several commands, interpreted in order under one group.
     */
    | { readonly _tag: "Batch"; readonly commands: ReadonlyArray<Command<A, R>> }

    /**
     * Interrupt running work by name. A command in its own right, so a handler
     * can invalidate work *another* action started — the cross-tag case no
     * combinator inside a single handler's effect can reach.
     */
    | { readonly _tag: "Cancel"; readonly target: Group }
  );

/**
 * What `Cancel` addresses: one name in one flat namespace, per mount.
 *
 * `keyed(name)` sets a command's whole address (outermost wins); an unkeyed
 * command books under its issuing action's tag, so the booking address is
 * always `key ?? tag`. A key equal to some action's tag is deliberate sharing,
 * not a collision — one namespace means one meaning per name.
 */
export type Group = string;

const pipeable = <T extends object>(value: T): T & Pipeable.Pipeable =>
  Object.assign(value, {
    pipe(this: T) {
      return Pipeable.pipeArguments(this, arguments);
    },
  });

/**
 * Discharges only the `R` channel of an effect, keeping its success type
 * exactly as inferred. Used once, by `run` — see the call site for why `R`
 * specifically cannot be verified in that scope.
 */
const discharge = <T>(effect: Effect.Effect<T, never, any>): Effect.Effect<T> =>
  effect as Effect.Effect<T>;

/**
 * The constructors, and the whole vocabulary a reducer has for describing work.
 */
export const Command: {
  readonly none: Command<never>;

  /**
   * The leaf. `dispatch` is how the command emits. Inside a handler's return
   * it is typed by the feature. Written outside one, name the messages it
   * may emit first, a message, record, `Task` or array of those, and `R` is
   * inferred: `Command.effect(Loaded, (dispatch) => …)`.
   */
  readonly effect: {
    <A = never, R = never>(
      effect: (dispatch: Dispatcher<A>) => Effect.Effect<unknown, never, R>,
    ): Command<A, R>;
    <const S extends MemberSource<Channel>, R = never>(
      source: S,
      effect: (dispatch: Dispatcher<MembersOf<S>>) => Effect.Effect<unknown, never, R>,
    ): Command<MembersOf<S>, R>;
  };

  /**
   * Names the group a command's fibers book under — the *whole* address,
   * outermost wins — so `Cancel` can find them by that one name. An unkeyed
   * command books under its issuing action's tag instead, which is why a
   * bare-tag cancel does not reach keyed work.
   */
  readonly keyed: {
    (key: string): <A, R>(command: Command<A, R>) => Command<A, R>;
    <A, R>(key: string, command: Command<A, R>): Command<A, R>;
  };

  /**
   * Commands in order, under one group. For composing *effects*, reach for
   * `Effect.all` inside a single `Command.effect` instead.
   */
  readonly batch: <A, R>(...commands: ReadonlyArray<Command<A, R>>) => Command<A, R>;

  /**
   * Interrupts the one group booked under `target`. A bare action tag reaches
   * only that tag's *unkeyed* fibers — keyed work answers to its own name.
   */
  readonly cancel: <A = never>(target: Group) => Command<A>;

  /**
   * Take-latest as one word: `restart(name, command)` is exactly
   * `batch(cancel(name), keyed(name, command))`. Sugar, not a variant — the
   * interpreter and devtools see the desugared batch.
   */
  readonly restart: {
    (name: Group): <A, R>(command: Command<A, R>) => Command<A, R>;
    <A, R>(name: Group, command: Command<A, R>): Command<A, R>;
  };

  /**
   * Outbound announcement.
   */
  readonly output: <M extends AnyMessage<"outbound">>(
    message: M,
    ...payload: PayloadArgs<M>
  ) => Command<M["Type"]>;
} = {
  none: pipeable({ _tag: "None" }),

  // The source only types `dispatch`; the leaf is the function either way.
  effect: ((first: unknown, second?: unknown) =>
    pipeable({ _tag: "Effect", effect: second ?? first })) as (typeof Command)["effect"],

  keyed: ((key: string, command?: Command<any, any>) =>
    command === undefined
      ? (inner: Command<any, any>) => pipeable({ _tag: "Keyed", key, command: inner })
      : pipeable({ _tag: "Keyed", key, command })) as (typeof Command)["keyed"],

  batch: (...commands) => pipeable({ _tag: "Batch", commands }),

  cancel: (target) => pipeable({ _tag: "Cancel", target }),

  restart: ((name: string, command?: Command<any, any>) => {
    // One spelling of the definitional identity, shared by both arities, so
    // the curried and two-argument forms cannot drift apart.
    const sugar = (inner: Command<any, any>) =>
      Command.batch(Command.cancel(name), Command.keyed(name, inner));
    return command === undefined ? sugar : sugar(command);
  }) as (typeof Command)["restart"],

  output: (message, ...payload) =>
    Command.effect<any>((dispatch) => dispatch(toMessage(message, payload[0]))),
};

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * A long-lived source, *declared* rather than issued: the feature's
 * `subscriptions` hook returns the set it wants for the current snapshot, and
 * the runtime diffs that set by key against what is running — starts the new
 * keys, stops the missing ones, leaves the rest alone. Stopping one means no
 * longer declaring it.
 *
 * One variant, and it is `Command.effect`'s leaf: everything Effect can
 * express is left to Effect — `Stream.runForEach` for a stream,
 * `Effect.acquireRelease` then `Effect.never` for a listener,
 * `Effect.retry(Schedule.exponential(…))` for reconnect. The error channel is
 * `never` on the same terms as a command's; what still dies is a defect, and
 * the runtime does not restart it.
 *
 * The record key is the whole identity. Two values under one key across two
 * folds are the same subscription, closures and all — so anything the effect
 * depends on belongs in the key: `` `presence:${props.roomId}` ``, not
 * `presence`.
 */
export type Subscription<A, R = never> = Pipeable.Pipeable & {
  readonly [subscription]: true;
  readonly _tag: "Effect";
  readonly effect: (dispatch: Dispatcher<A>) => Effect.Effect<unknown, never, R>;
};

/**
 * What the `subscriptions` hook returns: own keys only, in the order the
 * runtime starts them. A key whose value is `undefined` is not declared — so
 * `{ feed: online ? sub : undefined }` and `online ? { feed: sub } : {}` both
 * type-check and both mean the same thing.
 */
export type Subscriptions<A, R = never> = Readonly<Record<string, Subscription<A, R> | undefined>>;

/**
 * The hook itself — the pure read from a settled snapshot to the set of
 * subscriptions that snapshot wants. Called after every fold that moved
 * state or ambient inputs, so it should be cheap.
 */
export type SubscriptionsHook<Props, State, H extends AnyHooks, A, R = never> = (
  snapshot: Snapshot<Props, State, H>,
) => Subscriptions<A, R>;

/**
 * The one constructor. `dispatch` is how the subscription emits — actions
 * fold, outputs leave through `on<Tag>` — exactly as a command's leaf.
 */
export const Subscription: {
  /** As `Command.effect`: named messages first when written outside the hook. */
  readonly effect: {
    <A = never, R = never>(
      effect: (dispatch: Dispatcher<A>) => Effect.Effect<unknown, never, R>,
    ): Subscription<A, R>;
    <const S extends MemberSource<Channel>, R = never>(
      source: S,
      effect: (dispatch: Dispatcher<MembersOf<S>>) => Effect.Effect<unknown, never, R>,
    ): Subscription<MembersOf<S>, R>;
  };
} = {
  effect: ((first: unknown, second?: unknown) =>
    pipeable({
      [subscription]: true as const,
      _tag: "Effect",
      effect: second ?? first,
    })) as (typeof Subscription)["effect"],
};

/** The frozen empty set, for a feature that declared no hook. */
const NO_SUBSCRIPTIONS: Subscriptions<never> = Object.freeze({});

/** The keys a record declares: own keys, record order, `undefined` values skipped. */
const declaredKeys = (subscriptions: Subscriptions<any, any>): Array<string> =>
  Object.keys(subscriptions).filter((key) => subscriptions[key] !== undefined);

/**
 * One diff of the declared set: the keys `next` declares, against the keys
 * `previous` declared. Stops before starts is the caller's job; a key in both
 * is unchanged, whatever its fiber is doing.
 */
const diffDeclared = (
  previous: ReadonlySet<string>,
  next: Subscriptions<any, any>,
): {
  readonly wanted: ReadonlySet<string>;
  readonly stopping: ReadonlyArray<string>;
  readonly starting: ReadonlyArray<readonly [string, Subscription<any, any>]>;
} => {
  const keys = declaredKeys(next);
  const wanted = new Set(keys);
  const stopping: Array<string> = [];
  for (const key of previous) if (!wanted.has(key)) stopping.push(key);
  const starting: Array<readonly [string, Subscription<any, any>]> = [];
  for (const key of keys) if (!previous.has(key)) starting.push([key, next[key]!]);
  return { wanted, stopping, starting };
};

/**
 * The second book a mount (or a `run`) keeps beside its fiber book: one fiber
 * per declared key. A fiber that completed or died stays booked until its key
 * leaves the declared set, so a declared key that is done is unchanged, not
 * restarted. Never counted in `inFlight`.
 *
 * `fork` books the fiber and then attaches the exit observer, on
 * `forkLeaf`'s terms: an observer attached after the fiber has already exited
 * fires at attach, so a death between the fork and the booking is reported
 * against a booked key. The observer reports only while the key is still
 * booked to that fiber: a fiber that ended as its key was being stopped has
 * been reported by the stop already.
 *
 * `stop` unbooks the named fibers first, then interrupts them, awaited, so a
 * stopped subscription's finalizer has run and its last emission cannot land
 * after its stop.
 */
const subscriptionBook = (deps: {
  /** Where a subscription's emissions go, with the key they came from. */
  readonly emit: (key: string, message: { readonly _tag: string }) => Effect.Effect<void>;
  /** How a fiber still booked under `key` ended. Interruption included; callers filter. */
  readonly onExit: (key: string, exit: Exit.Exit<void>) => void;
}) => {
  const book = new Map<string, Fiber.Fiber<void>>();

  const fork = (key: string, sub: Subscription<any, any>) =>
    Effect.map(
      Effect.forkChild(
        Effect.asVoid(
          Effect.suspend(() => sub.effect(toDispatcher((message) => deps.emit(key, message)))),
        ),
      ),
      (fiber: Fiber.Fiber<void>) => {
        book.set(key, fiber);
        fiber.addObserver((exit) => {
          if (book.get(key) === fiber) deps.onExit(key, exit);
        });
      },
    );

  const stop = (keys: Iterable<string>) =>
    Effect.suspend(() => {
      const fibers: Array<Fiber.Fiber<void>> = [];
      for (const key of keys) {
        const fiber = book.get(key);
        if (fiber === undefined) continue;
        book.delete(key);
        fibers.push(fiber);
      }
      return Fiber.interruptAll(fibers);
    });

  return {
    fork,
    stop,
    /** Every booked key, running, done or died. */
    keys: () => [...book.keys()],
    get size() {
      return book.size;
    },
  } as const;
};

type SubscriptionBook = ReturnType<typeof subscriptionBook>;

/**
 * Attribution for a command's fibers. `tag` is the issuing action's, filled by
 * the runtime; `key` is whatever a `Keyed` node named it. The booking address
 * — the name a `Cancel` matches — is `key ?? tag`; both halves are kept so
 * devtools can attribute an emission to its action *and* its key.
 */
type CommandContext = {
  readonly tag: string;
  readonly key?: string;
};

/**
 * The fibers an interpreter has in flight, one flat map from group name to
 * fibers. A group exists only while it has a fiber, so "in flight" is the
 * book's size. Every mutation is synchronous and JS is single-threaded, so a
 * plain map suffices — fibers only interleave at yield points.
 */
type FiberBook = Map<Group, Set<Fiber.Fiber<void>>>;

const inFlight = (book: FiberBook): number => {
  let count = 0;
  for (const group of book.values()) count += group.size;
  return count;
};

/**
 * The command interpreter, shared by `Feature.run` and `createFeatureStore`.
 *
 * `interpret` walks a command, forking its leaves: `None` returns, `Effect`
 * forks the leaf with a `dispatch` bound to `deps.emit`, `Keyed` sets the key
 * for everything below it (outermost wins), `Batch` interprets members in
 * order under one context, `Cancel` interrupts every fiber at the address it
 * names.
 */
const commandInterpreter = (deps: {
  /**
   * Where a command's emissions go: back to the reducer, or out as an output.
   * `ctx` is the emitting command's group, so the store can attribute what it
   * folds; `run` ignores it.
   */
  readonly emit: (message: { readonly _tag: string }, ctx: CommandContext) => Effect.Effect<void>;
  /**
   * Runs after a command's fiber settles, however it settled — `run` needs it
   * to wake a `Queue.take` that quiescence would otherwise never unblock.
   */
  readonly settled: () => void;
  /**
   * How a command's fiber ended. `forkLeaf` forks and returns, so a dying
   * command dies on a fiber nobody awaits — without this hook every defect
   * from a command is discarded silently. Interruption is normal here
   * (`Cancel`, unmount), so callers filter on it. Runs before the fiber is
   * unbooked, so a fold it queues cannot be mistaken for quiescence.
   */
  readonly onExit?: (exit: Exit.Exit<void>, ctx: CommandContext) => void;
  readonly book: FiberBook;
}): {
  readonly interpret: (
    command: Command<any, any>,
    ctx: CommandContext,
  ) => Effect.Effect<void, never, any>;
} => {
  const { book } = deps;

  // Every fiber at the one name a `Cancel` addresses.
  const fibersAt = (target: Group): Array<Fiber.Fiber<void>> => [...(book.get(target) ?? [])];

  /**
   * Fork one leaf, register it under `ctx`'s group, unregister however it
   * ends.
   *
   * The exit is observed through `fiber.addObserver`, not from inside the
   * leaf: a fiber interrupted before the scheduler has started it never runs
   * its body, so an `Effect.ensuring` baked into the body would never run
   * either. The observer fires synchronously inside that interrupt, at attach
   * when the fiber has already exited, and once after a deferred interrupt
   * (`lib.probe.test.ts`). Booked before the observer is attached, so an
   * observer that fires at attach finds the booking it undoes.
   */
  const forkLeaf = (ctx: CommandContext, run: Effect.Effect<void, never, any>) =>
    Effect.map(Effect.forkChild(run), (fiber: Fiber.Fiber<void>) => {
      const name = ctx.key ?? ctx.tag;
      const group = book.get(name) ?? new Set<Fiber.Fiber<void>>();
      book.set(name, group);
      group.add(fiber);

      // No identity guard on the delete: a Set is deleted only when empty, by
      // the observer that emptied it, and observers run exactly once — so a
      // registered instance can never be a stale one. `finally`: the
      // bookkeeping has to survive an `onExit` that throws.
      fiber.addObserver((exit) => {
        try {
          deps.onExit?.(exit, ctx);
        } finally {
          group.delete(fiber);
          if (group.size === 0) book.delete(name);
          deps.settled();
        }
      });
    });

  const interpret = (
    command: Command<any, any>,
    ctx: CommandContext,
  ): Effect.Effect<void, never, any> =>
    Effect.gen(function* () {
      switch (command._tag) {
        case "None":
          return;
        case "Effect":
          // `suspend`, so a leaf builder that throws synchronously dies on the
          // command's own fiber and is reported through `onExit` rather than
          // escaping into the fold that called `interpret`.
          return yield* forkLeaf(
            ctx,
            Effect.asVoid(
              Effect.suspend(() =>
                command.effect(toDispatcher((action) => deps.emit(action, ctx))),
              ),
            ),
          );
        case "Keyed":
          // Outermost wins: an inner `Keyed` under an outer one keeps `ctx` whole.
          return yield* interpret(
            command.command,
            ctx.key === undefined ? { tag: ctx.tag, key: command.key } : ctx,
          );
        case "Batch":
          // One `ctx`, so every member shares the issuing action's group. In
          // order, because the one thing this node can do that `Effect.all`
          // cannot is put a `Cancel` before the command replacing it.
          for (const member of command.commands) yield* interpret(member, ctx);
          return;
        case "Cancel":
          return yield* Fiber.interruptAll(fibersAt(command.target));
      }
    });

  return { interpret } as const;
};

/**
 * A command that wants the state it is returned beside. Handed the tuple's
 * own state — the *next* state — once, by `Next.command`, so a handler can
 * write the next state inline and still give it to the command without
 * naming it first:
 *
 *     Added: ({ item }, { state }) => [
 *       { ...state, items: [...state.items, item] },
 *       (next) => persist(next),
 *     ]
 *
 * Not a `Command` variant: by the time the interpreter or devtools see it, it
 * is the command it returned.
 *
 * Written as a method type, so the parameter is checked **bivariantly**. A
 * handler's tuple state is routinely narrower than `State` — spreading a
 * value into an optional field makes it required — and under
 * `strictFunctionTypes` a `(next: Narrow) => …` would not fit
 * `Next<State>`'s slot. The thunk only ever receives the tuple's own state,
 * which is that narrow value, so the loosening costs nothing.
 */
export type LazyCommand<State, Action, R = never> = {
  bivariant(state: State): Command<Action, R>;
}["bivariant"];

/**
 * What a reducer returns: the next state, optionally with a command — given
 * outright, or as a {@link LazyCommand} of that state.
 */
export type Next<State, Action, R = never> =
  | State
  | readonly [State, Command<Action, R> | LazyCommand<State, Action, R>];

/**
 * Accessors, so a test can fold a sequence of actions without pattern matching
 * on the tuple at every step, and one constructor for the lazy tuple.
 *
 * `command` is the one place a lazy command is resolved: `reduce`'s
 * `Unmounted` branch, `run`, the store's fold and its teardown all read
 * through it, so there is no second site to keep in step.
 *
 * `lazy(state, thunk)` names the `[state, (next) => command]` tuple, for a
 * handler whose command reads the state it just built. `State` is inferred
 * from the first argument, so the thunk sees that exact shape. The eager
 * tuple stays a literal; `Task.start` is the sibling that also writes
 * `Pending`.
 */
export const Next: {
  readonly state: <State>(next: Next<State, any, any>) => State;
  readonly command: <State, Action, R>(
    next: Next<State, Action, R>,
  ) => Command<Action, R> | undefined;
  readonly lazy: <State, Action, R = never>(
    state: State,
    command: LazyCommand<State, Action, R>,
  ) => readonly [State, LazyCommand<State, Action, R>];
} = {
  state: (next) => (Array.isArray(next) ? next[0] : next),
  lazy: (state, command) => [state, command],
  command: (next) => {
    if (!Array.isArray(next)) return undefined;
    const command = next[1];
    return typeof command === "function" ? command(next[0]) : command;
  },
};

// ---------------------------------------------------------------------------
// Ambient inputs
// ---------------------------------------------------------------------------

export type AnyHooks = Record<string, unknown>;

/**
 * How hooks are written: React-ecosystem hooks — `useQuery`, `useMediaQuery`,
 * anything — called by the runtime in render position with the current props,
 * so the rules of hooks hold and `useThing(id)`-shaped hooks still work.
 */
export type HookSpec<Props, State, H extends AnyHooks> = (props: Props, state: State) => H;

/**
 * Everything readable at a moment: accumulated state plus ambient inputs.
 */
export interface Snapshot<Props, State, H extends AnyHooks> {
  readonly state: State;
  readonly props: Props;
  readonly hooks: H;
}

/**
 * What a reducer handler receives: the snapshot, plus a draft of its state.
 *
 * `draft` is a mutable view of `state`, made on first read and never for a
 * handler that does not touch it. Write into it and return it, alone or
 * beside a command; the fold replaces it with the finished value. An
 * untouched draft finishes to `state` itself, so returning it is the
 * no-op. Returning any other state discards the draft, and throws if the
 * draft was written to. `render` and `subscriptions` see a plain
 * `Snapshot`: neither is a place to change state.
 *
 * `tasks` holds one handle per key of `define`'s `tasks` slot, `{}` for a
 * feature without one. A handle writes into `draft`, so it is read on the
 * same terms: made on first read, and part of the one draft the handler
 * returns.
 */
export interface ReducerSnapshot<Props, State, H extends AnyHooks, TS = {}> extends Snapshot<
  Props,
  State,
  H
> {
  readonly draft: Draft<State>;
  readonly tasks: TaskHandles<TS, State>;
}

/** @internal One slot task, as `define` hands it to the fold: its key and binding. */
type SlotTask = {
  readonly key: string;
  readonly binding: TaskBinding<unknown, unknown, unknown, unknown, unknown, Channel>;
};

const NO_TASKS: {} = Object.freeze({});

/**
 * The one snapshot a handler is called with. The getter is on the
 * prototype: an accessor in an object literal costs V8 a fresh shape per
 * fold, twenty times the price of the fold itself; on a prototype it is a
 * property lookup.
 */
class FoldSnapshot<Props, State, H extends AnyHooks> implements ReducerSnapshot<
  Props,
  State,
  H,
  TaskSlots
> {
  #handle: DraftHandle<State> | undefined;
  #tasks: TaskHandles<TaskSlots, State> | undefined;
  readonly #drafter: DrafterService;
  readonly #slots: ReadonlyArray<SlotTask>;

  // Own keys stay `state`, `props`, `hooks`: the snapshot is the one object
  // this module claims is entirely encodable, and `Object.keys` is how a
  // test checks that. `draft` and `tasks` are on the prototype; the drafter
  // and the slot tasks are private.
  constructor(
    readonly state: State,
    readonly props: Props,
    readonly hooks: H,
    drafter: DrafterService,
    slots: ReadonlyArray<SlotTask>,
  ) {
    this.#drafter = drafter;
    this.#slots = slots;
  }

  get draft(): Draft<State> {
    return (this.#handle ??= openDraft(this.#drafter, this.state)).draft;
  }

  /**
   * The handles, built on first read. Each reads and writes its field
   * through `draft`, so a handle called after the handler wrote other
   * fields returns the one draft holding both.
   */
  get tasks(): TaskHandles<TaskSlots, State> {
    if (this.#tasks !== undefined) return this.#tasks;
    if (this.#slots.length === 0) return (this.#tasks = NO_TASKS);
    const handles: Record<string, unknown> = {};
    for (const { key, binding } of this.#slots) {
      const field = (): Record<string, unknown> => this.draft as Record<string, unknown>;
      handles[key] = {
        start: (input: unknown) => {
          const draft = field();
          const current = draft[key] as { readonly _tag?: unknown } | undefined;
          if (binding.first && current?._tag === "Pending") return [draft, Command.none];
          draft[key] = binding.pending;
          return [draft, binding.run(input)];
        },
        cancel: () => {
          const draft = field();
          draft[key] = binding.idle;
          return [draft, binding.cancel];
        },
      };
    }
    return (this.#tasks = Object.freeze(handles) as TaskHandles<TaskSlots, State>);
  }

  /**
   * Close the draft, if one was opened, and put the finished state where
   * the handler returned the draft. A handler that wrote into the draft and
   * returned something else is a defect: two next states, and no rule that
   * picks one.
   */
  finish(next: Next<State, any, any>): Next<State, any, any> {
    if (this.#handle === undefined) return next;
    // Take the tuple apart before the close: `Array.isArray` on a revoked
    // proxy throws, and a bare draft is a proxy.
    const tuple = Array.isArray(next);
    const returned = tuple ? next[0] : next;
    const finished = closeDraft(this.#handle);
    if (returned !== this.#handle.draft) {
      if (finished !== this.state) {
        throw new TypeError("handler wrote into snapshot.draft and returned a different state");
      }
      return next;
    }
    return tuple ? [finished, next[1]] : finished;
  }

  /** Close an open draft after a handler threw: unbook and revoke, decide nothing. */
  discard(): void {
    if (this.#handle !== undefined) closeDraft(this.#handle);
  }
}

/**
 * The view's dispatch, called from an event handler. The same two forms as
 * `Dispatcher`: `dispatch(Typed, { query })`, `dispatch(Cleared)`, or a built
 * message.
 */
export interface Dispatch<Action> {
  <M extends MessageOf<Action>>(message: M, ...payload: PayloadArgs<M>): void;
  (action: Action): void;
}

export interface RenderSnapshot<Props, State, Action, H extends AnyHooks> extends Snapshot<
  Props,
  State,
  H
> {
  readonly dispatch: Dispatch<Action>;
}

/** Pure. `ReactNode` out, JSX in — nothing accumulates through the tree. */
export type Render<Props, State, Action, H extends AnyHooks> = (
  snapshot: RenderSnapshot<Props, State, Action, H>,
) => ReactNode;

// ---------------------------------------------------------------------------
// Lifecycle actions
// ---------------------------------------------------------------------------

export type HookChanged<H extends AnyHooks> = {
  readonly _tag: "HookChanged";
  readonly previous: H;
};

/**
 * The lifecycle actions as values, `Unmounted` among them — so `feature.reduce`
 * can be handed one and teardown is testable without mounting anything.
 */
export type LifecycleAction<Props, H extends AnyHooks> =
  | { readonly _tag: "Mounted" }
  | {
      readonly _tag: "PropsChanged";
      readonly previous: Props;
    }
  | HookChanged<H>
  | {
      readonly _tag: "Error";
      readonly error: unknown;
      readonly cause: Cause.Cause<never>;
      /**
       * Where the defect came from: the tag of the action whose command died
       * or whose handler threw, or `"Mounted"` for a feature layer that failed
       * to build, or `"Unmounted"` for a teardown that threw or overran, or
       * the key of a subscription that died. Lets a handler tell an
       * infrastructure failure from one bad command. Two namespaces in one
       * string, accepted: a devtools sink sees the cause, the action does not.
       */
      readonly from: string;
    }
  | { readonly _tag: "Unmounted" };

/**
 * One handler, in the shape every other handler has. The action shape comes from
 * `LifecycleAction`, so there is one place a lifecycle action is described.
 */
type LifecycleHandler<Tag extends LifecycleTag, Props, State, Action, H extends AnyHooks, R, TS> = (
  payload: Simplify<Omit<Extract<LifecycleAction<Props, H>, { readonly _tag: Tag }>, "_tag">>,
  snapshot: ReducerSnapshot<Props, State, H, TS>,
) => Next<State, Action, R>;

/**
 * Actions the runtime raises. All optional.
 */
export interface LifecycleHandlers<Props, State, Action, H extends AnyHooks, R = never, TS = {}> {
  /** Fires once, after the initial state exists. Where startup commands live. */
  readonly Mounted?: LifecycleHandler<"Mounted", Props, State, Action, H, R, TS>;

  /**
   * Fires when props change **by value** (`Schema.toEquivalence`), so an
   * unchanged parent re-render folds nothing. Raised after the render that
   * carried the props commits, never for a render React abandons. Returning
   * the same state reference is the no-op.
   */
  readonly PropsChanged?: LifecycleHandler<"PropsChanged", Props, State, Action, H, R, TS>;

  /**
   * Fires whenever any hook's value changes, whole-object like `PropsChanged`.
   */
  readonly HookChanged?: LifecycleHandler<"HookChanged", Props, State, Action, H, R, TS>;

  /**
   * Commands cannot fail, but they can still *die*; a handler can throw; and
   * a feature layer can fail to build. All three arrive here as defects. Left
   * unhandled, the defect is rethrown into the nearest React error boundary.
   * `error` is the squashed cause; `cause` is always `Cause.die(error)`.
   */
  readonly Error?: LifecycleHandler<"Error", Props, State, Action, H, R, TS>;

  /**
   * The component is gone, so the runtime reads `Next.command(…)` and
   * discards the rest — return `snapshot.state` and put the work in the
   * command. `feature.reduce` discards identically, so a teardown test
   * folded through `reduce` cannot disagree with the runtime.
   */
  readonly Unmounted?: LifecycleHandler<"Unmounted", Props, State, Action, H, R, TS>;
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export type StatePart<N> = N extends readonly [infer S, unknown] ? S : N;

export type Excess<N, State> = N extends unknown ? Exclude<keyof StatePart<N>, keyof State> : never;

/**
 * Two guards `Reducer`'s constraint cannot express, both surfaced as an error
 * string on the offending key: a handler whose returned state has a property
 * `State` does not, and a key that is neither an action tag nor a lifecycle
 * tag — excess-property checking never sees `U`, since it is inferred from the
 * literal, so `subscriptions: () => …` under `reducer` would otherwise
 * compile as an ignored handler.
 */
export type Exhaustive<U, State, Allowed extends string = string> = {
  readonly [K in keyof U]: K extends Allowed
    ? U[K] extends (...args: never) => infer N
      ? [Excess<N, State>] extends [never]
        ? unknown
        : `state has no property ${Excess<N, State> & string}`
      : unknown
    : `not a handler: "${K & string}" is neither an action tag nor a lifecycle tag`;
};

/**
 * Exhaustive over the declared actions; lifecycle handlers stay optional; output
 * tags are absent from the key set, so writing a handler for one is a compile
 * error. The settle tags of a `tasks` slot (`TS`) are optional too: the fold
 * writes the field itself, and a handler written for one runs after that
 * write.
 *
 * A handler receives the action's **payload** — `_tag` stripped, on the same
 * terms as an output crossing into its `on<Tag>` prop: the handler's own key
 * already did the discrimination, so the tag is spent routing information.
 * What remains is plain data, safe to store in state or forward into a
 * command whole.
 */
export type Reducer<
  Props,
  State,
  A extends Tagged,
  O extends Tagged,
  H extends AnyHooks,
  R = never,
  TS = {},
> = ActionHandlers<Props, State, A, O, H, R, TS> &
  LifecycleHandlers<Props, State, Emit<A, O>, H, R, TS>;

/** The action handlers: required per declared tag, optional per settle tag of a slot task. */
type ActionHandlers<Props, State, A extends Tagged, O extends Tagged, H extends AnyHooks, R, TS> = {
  readonly [K in Exclude<A["_tag"], TaskActionsOf<TS>["_tag"]>]: (
    payload: Simplify<Omit<Extract<A, { readonly _tag: K }>, "_tag">>,
    snapshot: ReducerSnapshot<Props, State, H, TS>,
  ) => Next<State, Emit<A, O>, R>;
} & {
  readonly [K in TaskActionsOf<TS>["_tag"]]?: (
    payload: Simplify<Omit<Extract<A, { readonly _tag: K }>, "_tag">>,
    snapshot: ReducerSnapshot<Props, State, H, TS>,
  ) => Next<State, Emit<A, O>, R>;
};

const internals: unique symbol = Symbol("@wych/internals");

/**
 * What a store exposes behind `internals`, for the stress and leak tests only.
 * Not exported by name: a test reaches it through the symbol's description, as
 * the internals test in `lib.test.ts` does, and the docs never list it.
 */
interface StoreInternals {
  /** A mount is installed (live, or draining its teardown). */
  readonly mounted: boolean;
  readonly active: boolean;
  readonly dead: boolean;
  /** Work items the mount fiber has not taken yet. */
  readonly queued: number;
  /** Command fibers in flight, on the installed mount. */
  readonly inFlight: number;
  /** Groups with at least one fiber booked. */
  readonly groups: number;
  /** Command fibers booked across every group. A fiber is unbooked by its exit observer, synchronously. */
  readonly fibers: number;
  /** Booked command fibers that have not exited. Equal to `fibers` unless an interrupt is deferred by an uninterruptible region. */
  readonly live: number;
  /** Subscription fibers booked, running, done or died. */
  readonly subscriptions: number;
  /** Keys the last diff declared. */
  readonly declared: number;
  /** Work offered before the first `start()`. */
  readonly buffered: number;
  /** Actions waiting to fold in the current drain. */
  readonly pending: number;
  readonly subscribers: number;
}

export interface FeatureInternals<Props, State, Action, H extends AnyHooks> {
  readonly initialState: (props: Props) => State;
  readonly render: Render<Props, State, Action, H>;
  readonly useUnsafeHooks: HookSpec<Props, State, H> | undefined;

  /**
   * Whether the feature declared a `subscriptions` hook. The store checks it
   * once and, when `false`, never evaluates a diff.
   */
  readonly subscribes: boolean;

  /**
   * The props schema on its `Type` side alone. Props are **validated, never
   * decoded**: `define` strips any encoding a field declares with
   * `Schema.toType`, so `props.x` is always exactly what the parent passed —
   * a transforming field never re-decodes on a parent render, and the parent
   * is never asked for the wire shape.
   */
  readonly props: Schema.toType<AnyPropsSchema>;
  readonly outputTags: ReadonlyArray<string>;

  /**
   * The props that must not reach a devtools sink, with what stands in for
   * them. Empty for a feature whose props are all schema values.
   */
  readonly opaqueProps: ReadonlyArray<readonly [string, unknown]>;

  /**
   * Whether the feature declared a handler for this tag.
   */
  readonly handles: (tag: string) => boolean;
}

/**
 * A feature's behaviour, before it is wired to a runtime. `component` turns one
 * into an `FC<Props>`; until then it is an inert value you can unit-test.
 */
export interface Feature<in Props, State, Action, Output, H extends AnyHooks = {}, out R = never> {
  /** @internal Not part of the surface — see `FeatureInternals`. */
  readonly [internals]: FeatureInternals<Props, State, Action | Output, H>;

  /**
   * The reducer as one pure function, with the snapshot standing in for the
   * state. The handler's `draft` is made here, over `snapshot.state`, and
   * finished before the result is returned, so a test never sees a proxy.
   * `drafter` is `mutativeDrafter` unless a test hands it another.
   */
  readonly reduce: (
    action: Action | LifecycleAction<Props, H>,
    snapshot: Snapshot<Props, State, H>,
    drafter?: DrafterService,
  ) => Next<State, Action | Output, R>;

  /**
   * The subscriptions hook as one pure function: what this snapshot declares,
   * as a record, `{}` for a feature with no hook. "Which keys does this state
   * want" is then a test with no runtime, on the same terms as `reduce`.
   */
  readonly subscriptions: SubscriptionsHook<Props, State, H, Action | Output, R>;

  /**
   * Fold a sequence, run each command against `layer`, feed what it emits back
   * in, and report what left.
   *
   * A command that dies is recorded in `defects` and, when the feature has an
   * `Error` handler, folded through it exactly as the store would — so "given
   * a failing command, this feature recovers" is a `state` assertion, and
   * "this command failed" is a `defects` assertion. `run` stays total either
   * way: a defect never fails the returned Effect.
   *
   * Resolves at *command* quiescence: nothing queued and no command fiber in
   * flight. The hook is evaluated after each reduced action and its diff
   * applied on the store's rules, so a subscription over a synchronous stub
   * (`Stream.fromArray`) has emitted before the next action is reduced; a
   * subscription that never completes holds nothing open. At resolve the
   * declared keys are reported in `subscriptions` and every subscription
   * fiber is interrupted, finalizers awaited. A source that emits on a timer
   * loses its late emission with that interrupt — drive `createFeatureStore`
   * by hand for timing claims.
   */
  readonly run: (
    actions: Iterable<Action | LifecycleAction<Props, H>>,
    options: {
      readonly props: Props;
      readonly hooks: H;
      readonly layer: Layer.Layer<R>;
    },
  ) => Effect.Effect<{
    readonly state: State;
    readonly emitted: ReadonlyArray<Action>;
    readonly outputs: ReadonlyArray<Output>;
    readonly defects: ReadonlyArray<RunDefect>;
    /** The keys declared when `run` resolved, in record order. */
    readonly subscriptions: ReadonlyArray<string>;
  }>;
}

/**
 * One command or subscription death observed by `Feature.run`, in the order
 * it was seen. Interruption (`Cancel`, `restart`, an undeclared key) is how
 * work normally ends and is not a defect.
 */
export interface RunDefect {
  /**
   * The tag of the action whose command died or whose hook evaluation threw,
   * or the key of the subscription that died.
   */
  readonly from: string;
  /** The squashed cause: the thrown value, or what `Effect.die` was given. */
  readonly error: unknown;
  /**
   * Whether the feature's `Error` handler folded it. `false` when there is no
   * handler, or when the dying command was the `Error` handler's own — the
   * same rule the store applies before it throws to the boundary.
   */
  readonly handled: boolean;
}

// ---------------------------------------------------------------------------
// Defining a feature
// ---------------------------------------------------------------------------

/**
 * What `define` hands back: the pieces of a feature, each already bound to
 * this feature's `Props`, `State`, vocabularies and hooks.
 *
 * `initialState`, `reducer`, `render` and `subscriptions` are identity
 * functions at runtime. They exist only to *supply* those types, which is
 * what makes a piece writable on its own.
 */
export interface FeatureDefinition<
  Props,
  State,
  A extends Tagged,
  O extends Tagged,
  H extends AnyHooks,
  TS = {},
> {
  /**
   * The initial state, without the `tasks` slot's fields: the runtime fills
   * each with `Task.idle`, then spreads this state over them.
   */
  readonly initialState: (
    initialState: (props: Props) => InitialStateOf<State, TS>,
  ) => (props: Props) => InitialStateOf<State, TS>;

  readonly reducer: <U extends Reducer<Props, State, A, O, H, any, TS>>(
    reducer: U & Exhaustive<U, State, A["_tag"] | LifecycleTag>,
  ) => U;

  /**
   * The subscriptions hook, typed: `dispatch` inside each leaf carries the
   * feature's vocabulary, `snapshot` is the feature's `Snapshot`, and `R` is
   * read off the record's values.
   */
  readonly subscriptions: <R = never>(
    subscriptions: SubscriptionsHook<Props, State, H, Emit<A, O>, R>,
  ) => SubscriptionsHook<Props, State, H, Emit<A, O>, R>;

  /**
   * `render`'s dispatch carries the outbound vocabulary too: the store routes
   * every dispatched message by tag, so an output dispatched from the view
   * leaves through its `on<Tag>` prop without touching the reducer. Declare a
   * mirror action instead when the feature's own state must witness what left.
   */
  readonly render: (
    render: Render<Props, State, Emit<A, O>, H>,
  ) => Render<Props, State, Emit<A, O>, H>;

  /**
   * Build the feature. `subscriptions` is optional, and absent means nothing
   * runs and nothing is paid: the store never evaluates a diff. The
   * parameter's type is what gives each leaf's `dispatch` its contextual
   * type — as `U extends Reducer<…>` does for `Command.effect` — so written
   * standalone a subscription needs the type argument. `SR` is inferred from
   * the record's values and unioned into the feature's `R`, so a service a
   * subscription needs is a compile error at `component`.
   */
  readonly create: <U extends Reducer<Props, State, A, O, H, any, TS>, SR = never>(parts: {
    readonly initialState: (props: Props) => InitialStateOf<State, TS>;
    readonly reducer: U & Exhaustive<U, State, A["_tag"] | LifecycleTag>;
    readonly render: Render<Props, State, Emit<A, O>, H>;
    readonly subscriptions?: SubscriptionsHook<Props, State, H, Emit<A, O>, SR>;
  }) => Feature<Props, State, A, O, H, ServicesOf<U> | SR>;
}

/** Where a settle action lands: the slot key, the payload field, and the value it becomes. */
type Settle = {
  readonly key: string;
  readonly field: "value" | "error";
  readonly write: (x: unknown) => unknown;
};

/**
 * The state with a settle action's field written, through a draft of its
 * own: the same drafter, so the result is frozen as any folded state is.
 */
const settled = (
  settle: Settle,
  action: { readonly _tag: string; readonly [field: string]: unknown },
  state: unknown,
  drafter: DrafterService,
): unknown => {
  const handle = openDraft(drafter, state);
  (handle.draft as Record<string, unknown>)[settle.key] = settle.write(action[settle.field]);
  return closeDraft(handle);
};

/**
 * Declare what a feature is made of, then build it.
 *
 * Every piece arrives from a *value*, so there are no explicit type arguments
 * at all — `Props`, `State`, the vocabularies and the hooks are inferred from
 * one object literal. `actions` and `outputs` each take a message, a record of
 * messages, a `Task`, or an array of those.
 *
 *     const Cart = define({
 *       props: Props,
 *       state: State,
 *       tasks: { checkout },
 *       actions,
 *       outputs: OrderPlaced,
 *       useUnsafeHooks: …,
 *     })
 *
 *     export const cart = Cart.create({ initialState, reducer, render })
 *
 * `tasks` binds each `Task` operation to a state field of its own, under
 * its key. The key adds a `TaskValue` field to `State`, typed and
 * validated by the operation's `schema`, and the operation's two actions to
 * the action union. The field starts `Idle`, so `initialState` leaves it
 * out. Settling writes `Resolved` or `Rejected` into the field before the
 * reducer's settle handler runs, which makes that handler optional. A
 * handler starts and cancels the work through `snapshot.tasks.<key>`.
 *
 * Each of these throws a `TypeError` here, and each is a compile error
 * where the types can see it: a task key that is also a state field; a task
 * tag also declared in `actions` or `outputs`, which is also what one
 * operation in both `tasks` and `actions` looks like; one operation under
 * two keys; and a `Task.output` operation in `tasks`.
 */
export const define: <
  PropsSchema extends AnyPropsSchema,
  StateSchema extends AnyStateSchema,
  const AS extends MemberSource<"internal">,
  const OS extends MemberSource<"outbound"> = readonly [],
  H extends AnyHooks = {},
  const TS extends TaskSlots = {},
>(spec: {
  readonly props: PropsSchema;
  readonly state: StateSchema;
  readonly tasks?: TS &
    NoTaskCollision<StateSchema, TS> &
    NoDuplicateTaskTags<TS> &
    Disjoint<MembersOf<AS> | MembersOf<OS>, TaskActionsOf<TS>>;
  readonly actions: AS;
  readonly outputs?: OS &
    Disjoint<MembersOf<AS>, MembersOf<OS>> &
    NoPropCollision<PropsSchema, MembersOf<OS>>;

  readonly useUnsafeHooks?: HookSpec<PropsOf<PropsSchema>, WithTasks<StateOf<StateSchema>, TS>, H>;
}) => FeatureDefinition<
  PropsOf<PropsSchema>,
  WithTasks<StateOf<StateSchema>, TS>,
  MembersOf<AS> | TaskActionsOf<TS>,
  MembersOf<OS>,
  H,
  TS
> = ((spec: {
  readonly props: AnyPropsSchema;
  readonly state: AnyStateSchema;
  readonly tasks?: Readonly<Record<string, unknown>>;
  readonly actions: unknown;
  readonly outputs?: unknown;
  readonly useUnsafeHooks?: HookSpec<any, any, any>;
}): FeatureDefinition<any, any, any, any, any, any> => {
  // The slot types already hold both checks; these catch a source that got
  // past them through a cast, where a wrong channel would route an action
  // out through a prop, or an output into the reducer.
  const seen = new Set<string>();
  tagsIn(spec.actions, "internal", "actions", seen);
  const outputTags =
    spec.outputs === undefined ? [] : tagsIn(spec.outputs, "outbound", "outputs", seen);

  const slots = slotTasks(spec, seen);
  const state =
    slots.length === 0
      ? spec.state
      : Schema.Struct({
          ...spec.state.fields,
          ...Object.fromEntries(slots.map(({ key, binding }) => [key, binding.schema])),
        });

  // Opaque declarations (`Children`) are redacted only in `PropsChanged`
  // events; state reaches devtools transitions verbatim. Refusing them here
  // keeps the "every event is encodable" contract honest.
  const opaqueState = opaqueProps(state);
  if (opaqueState.length > 0) {
    throw new TypeError(
      `Opaque field "${opaqueState[0][0]}" declared in the state schema; ` +
        "opaque declarations like Children belong in props",
    );
  }

  // Settle tag to the field it writes and how.
  const settles = new Map<string, Settle>();
  for (const { key, binding } of slots) {
    settles.set(binding.resolvedTag, { key, field: "value", write: binding.resolved });
    settles.set(binding.rejectedTag, { key, field: "error", write: binding.rejected });
  }
  const idles = Object.fromEntries(slots.map(({ key, binding }) => [key, binding.idle]));

  return {
    initialState: (initialState) => (props) => initialState(props),
    reducer: identity,
    render: identity,
    subscriptions: identity,
    create: (parts) => {
      const outputTagSet = new Set(outputTags);
      const subscriptions: SubscriptionsHook<any, any, any, any, any> =
        parts.subscriptions ?? (() => NO_SUBSCRIPTIONS);
      // The slot's fields start `Idle`, under whatever the feature returns.
      const initialState: (props: any) => any =
        slots.length === 0
          ? parts.initialState
          : (props) => ({ ...idles, ...parts.initialState(props) });

      /**
       * A missing handler is the documented no-op only for a *lifecycle* tag —
       * every `LifecycleHandlers` entry is optional by design. A missing
       * handler for anything else is a defect: `Reducer` requires one for
       * every declared action tag, so reaching that branch means the action
       * arrived without going through the typed surface.
       *
       * `Unmounted`'s returned state is discarded: the component is gone, so
       * the state has nowhere to go. Only the command survives — `run` and the
       * store both fold through here, so they cannot disagree.
       */
      const reduce = (
        action: { readonly _tag: string },
        snapshot: Snapshot<any, any, any>,
        drafter: DrafterService = mutativeDrafter,
      ): Next<any, any, any> => {
        const handler = handlerFor(parts.reducer, action._tag);
        const settle = settles.size === 0 ? undefined : settles.get(action._tag);
        if (handler) {
          // The handler key already did the discrimination, so the tag is
          // spent — stripped on the same terms as `emit` strips it for the
          // `on<Tag>` prop. What the handler holds cannot smuggle a tag into
          // state or a command's payload.
          const { _tag, ...payload } = action;
          // A settle handler folds over the state with its field already
          // written, so returning `snapshot.state` is the field write alone.
          const state =
            settle === undefined
              ? snapshot.state
              : settled(settle, action, snapshot.state, drafter);
          const fold = new FoldSnapshot(state, snapshot.props, snapshot.hooks, drafter, slots);
          // `finish` runs whether or not the handler threw: an open draft
          // must be closed and unbooked before the defect propagates.
          let next: Next<any, any, any>;
          try {
            next = handler(payload, fold);
          } catch (error) {
            fold.discard();
            throw error;
          }
          next = fold.finish(next);
          if (action._tag !== "Unmounted") return next;
          const command = Next.command(next);
          return command === undefined ? snapshot.state : [snapshot.state, command];
        }
        if (settle !== undefined) return settled(settle, action, snapshot.state, drafter);
        if (isLifecycleTag(action._tag)) return snapshot.state;
        throw new TypeError(`No reducer handler for action "${action._tag}"`);
      };

      return {
        [internals]: {
          initialState,
          render: parts.render,
          useUnsafeHooks: spec.useUnsafeHooks,
          subscribes: parts.subscriptions !== undefined,
          props: Schema.toType(spec.props),
          outputTags,
          opaqueProps: opaqueProps(spec.props),
          handles: (tag) => handlerFor(parts.reducer, tag) !== undefined || settles.has(tag),
        },

        reduce,

        subscriptions,

        run: (actions, options) =>
          discharge(
            Effect.gen(function* () {
              type Entry = {
                readonly msg: { readonly _tag: string; readonly [key: string]: unknown };
                readonly origin: "seed" | "command" | "subscription" | "settled" | "runtime";
              };

              const queue = yield* Queue.unbounded<Entry>();
              const book: FiberBook = new Map();
              let declared: ReadonlySet<string> = new Set();
              const emitted: { _tag: string }[] = [];
              const outputs: { _tag: string }[] = [];
              const defects: RunDefect[] = [];
              const handlesError = handlerFor(parts.reducer, "Error") !== undefined;
              const snapshot = { props: options.props, hooks: options.hooks };
              // Total: a `Reference` reads its default when the layer has none.
              const drafter = yield* Effect.service(Drafter);
              let state = initialState(options.props);

              for (const action of actions) {
                yield* Queue.offer(queue, { msg: action, origin: "seed" });
              }

              const isOutput = (action: { _tag: string }): boolean => outputTagSet.has(action._tag);

              // The store's rule, minus the sink and the boundary: record the
              // death, and fold `Error` when the feature handles it. `"runtime"`
              // origin: the action is the runtime's own, so it is not `emitted`.
              const raise = (error: unknown, from: string): void => {
                const handled = from !== "Error" && handlesError;
                defects.push({ from, error, handled });
                if (!handled) return;
                Queue.offerUnsafe(queue, {
                  msg: { _tag: "Error", error, cause: Cause.die(error), from },
                  origin: "runtime",
                });
              };

              // The second book. Never counted in `inFlight`, so a subscription
              // that never completes holds nothing open — that is the whole
              // point of the split.
              const running = subscriptionBook({
                emit: (_key, msg) =>
                  Queue.offer(queue, { msg, origin: "subscription" }).pipe(Effect.asVoid),
                onExit: (key, exit) => {
                  if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
                    raise(Cause.squash(exit.cause), key);
                  }
                },
              });

              const { interpret } = commandInterpreter({
                book,
                emit: (msg) => Queue.offer(queue, { msg, origin: "command" }).pipe(Effect.asVoid),
                // A command that settles without ever emitting (a `Command.effect`,
                // an interrupted/cancelled group) still has to wake the drain loop's
                // `Queue.take` — otherwise quiescence is reached but nothing is left
                // to unblock it. A no-op entry does that uniformly.
                settled: () =>
                  Queue.offerUnsafe(queue, { msg: { _tag: "__settled__" }, origin: "settled" }),
                onExit: (exit, ctx) => {
                  if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
                    raise(Cause.squash(exit.cause), ctx.tag);
                  }
                },
              });

              // The diff, on the store's rules: keys only, stops before starts,
              // a key still in the book — running, done or died — is unchanged.
              const reconcile = (from: string) =>
                Effect.gen(function* () {
                  let next: Subscriptions<any, any>;
                  try {
                    next = subscriptions({ ...snapshot, state });
                  } catch (error) {
                    return raise(error, from);
                  }
                  const { wanted, stopping, starting } = diffDeclared(declared, next);
                  yield* running.stop(stopping);
                  for (const [key, sub] of starting) yield* running.fork(key, sub);
                  declared = wanted;
                });

              // Drain until quiescent: nothing queued and nothing running. The
              // two reads are synchronous back to back, so no fiber can settle
              // or emit between them.
              while (inFlight(book) > 0 || Queue.sizeUnsafe(queue) > 0) {
                const entry = yield* Queue.take(queue);
                if (entry.origin === "settled") continue;
                if (isOutput(entry.msg)) {
                  outputs.push(entry.msg);
                  continue;
                }
                if (entry.origin === "command" || entry.origin === "subscription") {
                  emitted.push(entry.msg);
                }

                const next = reduce(entry.msg, { ...snapshot, state }, drafter);
                const command = Next.command(next);
                state = Next.state(next);
                if (command) yield* interpret(command, { tag: entry.msg._tag });
                // `Unmounted` empties the declared set, as `stop()` does on the
                // store; every other action re-evaluates the hook.
                if (entry.msg._tag === "Unmounted") {
                  yield* running.stop(declared);
                  declared = new Set();
                } else if (parts.subscriptions !== undefined) {
                  yield* reconcile(entry.msg._tag);
                }
                // Let the fibers this action forked run to their first
                // suspension before the next action is reduced. Seeded actions
                // then behave like dispatches separated by an event-loop turn:
                // a `restart` from the second seed interrupts a request the
                // first seed already sent, rather than one that never started.
                // A subscription over a synchronous stub emits here too.
                yield* Effect.yieldNow;
              }

              // The report is the declared set at resolve; then nothing leaks
              // past the returned Effect — awaited, so a finalizer inside a
              // subscription has run by the time the caller reads the result.
              const subscriptionKeys = [...declared];
              yield* running.stop(declared);

              return { state, emitted, outputs, defects, subscriptions: subscriptionKeys };
            }).pipe(Effect.provide(options.layer)),
          ),
      };
    },
  };
}) as never;

// ---------------------------------------------------------------------------
// Mounting a feature
// ---------------------------------------------------------------------------

/**
 * The live half of `run`, and the seam the React binding is written against.
 */
export interface FeatureStore<Props, State, Action, H extends AnyHooks, Output = never> {
  /** The `useSyncExternalStore` pair. `getSnapshot` must be reference-stable
   *  between changes, or React re-renders forever. */
  readonly subscribe: (onStoreChange: () => void) => () => void;
  readonly getSnapshot: () => State;

  /**
   * `render`'s dispatch: the feature's actions and its outputs, routed by tag.
   * Stable identity — it lands in props.
   */
  readonly dispatch: Dispatch<Action | Output>;

  /**
   * The snapshot's ambient half, and, because it is the only thing that sees
   * both the old and new values, the place `PropsChanged` and `HookChanged`
   * are detected and raised. Called from a layout effect, once per committed
   * render, never from the render body. Before the first `start` it only
   * records, so `Mounted` is the first lifecycle action folded and sees the
   * props and hooks in force at mount. Returns the post-fold state, so a
   * caller driving the store by hand sees the change the sync just caused.
   */
  readonly sync: (props: Props, hooks: H) => State;

  /**
   * Open the mount, build the feature layer inside it, raise `Mounted`.
   * Idempotent while started; calling it after `stop` re-arms the store (the
   * StrictMode remount path), reusing the existing state.
   */
  readonly start: () => void;

  /**
   * Raise `Unmounted`, run its command with the feature's services still
   * alive, and close the mount once that command settles.
   */
  readonly stop: () => void;
}

/** Devtools instance ids: unique per page, not gapless, not per-name. */
let instanceCount = 0;

const DISPATCH: DevtoolsCause = Object.freeze({ _tag: "Dispatch" as const });
const LIFECYCLE: DevtoolsCause = Object.freeze({ _tag: "Lifecycle" as const });
const HOOK_CHANGED_ACTION = Object.freeze({ _tag: "HookChanged" as const });

/**
 * What a devtools sink is allowed to see of an action.
 *
 * `Error` is scrubbed to its tag and `from` (a live `Error` and a `Cause` do
 * not encode; the origin tag does), `HookChanged` to its tag alone (a record
 * that routinely holds functions).
 * `PropsChanged` keeps its `previous` props — they are schema values and they
 * encode — except for the ones declared opaque, which are replaced by their
 * placeholder. That is what keeps every event JSON round-trippable once a
 * feature declares `children`.
 */
const reportableAction = (
  action: { readonly _tag: string },
  opaqueFields: ReadonlyArray<readonly [string, unknown]>,
): { readonly _tag: string } => {
  if (action._tag === "Error") {
    const scrubbed: { readonly _tag: string; readonly from?: string } = {
      _tag: "Error",
      from: (action as { readonly from?: string }).from,
    };
    return scrubbed;
  }
  if (action._tag === "HookChanged") return HOOK_CHANGED_ACTION;
  if (action._tag !== "PropsChanged" || opaqueFields.length === 0) return action;

  const { previous } = action as { readonly previous?: Record<string, unknown> };
  if (previous === null || typeof previous !== "object") return action;

  let redacted: Record<string, unknown> | undefined;
  for (const [key, placeholder] of opaqueFields) {
    if (!Object.hasOwn(previous, key)) continue;
    redacted ??= { ...previous };
    redacted[key] = placeholder;
  }

  if (redacted === undefined) return action;
  return { ...action, previous: redacted } as { readonly _tag: string };
};

const commandCause = (ctx: CommandContext): DevtoolsCause =>
  ctx.key === undefined
    ? { _tag: "Command", action: ctx.tag }
    : { _tag: "Command", action: ctx.tag, key: ctx.key };

export const createFeatureStore = <Props, State, Action, Output, H extends AnyHooks>(args: {
  readonly feature: Feature<Props, State, Action, Output, H, any>;
  readonly props: Props;
  readonly equivalence: {
    readonly props: Equivalence.Equivalence<Props>;
    readonly hooks: Equivalence.Equivalence<H>;
  };
  /** Any root runtime: `R` is contravariant, so `never` accepts every one. */
  readonly runtime: ManagedRuntime.ManagedRuntime<never, unknown>;
  readonly layer: Layer.Layer<any, any, any> | undefined;
  readonly emit: (output: { readonly _tag: string }) => void;
  readonly defect: (error: unknown) => void;
  readonly name?: string;
  readonly instance?: string;
}): FeatureStore<Props, State, Action, H, Output> => {
  const { feature, equivalence, layer, emit, defect } = args;
  // The store reads the root context and forks on it; which services the
  // root provides is `component`'s check, not the store's.
  const runtime = args.runtime as ManagedRuntime.ManagedRuntime<any, any>;
  const {
    initialState,
    outputTags,
    opaqueProps: opaqueFields,
    handles,
    subscribes,
  } = feature[internals];

  const name = args.name ?? "WychFeature";
  const instance = args.instance ?? String(++instanceCount);

  /**
   * The installed sink: `undefined` until the runtime's context exists to
   * read it from, `null` once read and found to be `noopDevtools`, or
   * disabled after it threw.
   */
  let sink: DevtoolsSink | null | undefined;

  /**
   * Hand one event to the sink, and disable the sink if it throws. The event
   * is built only once a sink is known to want it, so the no-sink path
   * allocates nothing. Re-reads `sink` per event: a single fold reports
   * twice, and a sink that threw on the first event must not be called for
   * the second.
   */
  const report = (build: () => DevtoolsEvent): void => {
    if (sink === undefined) {
      const context = runtime.cachedContext;
      if (context === undefined) return;
      const installed = Context.getUnsafe(context, Devtools);
      sink = installed === noopDevtools ? null : installed;
    }
    if (sink === null) return;
    try {
      sink.onEvent(build());
    } catch {
      sink = null;
    }
  };

  const outputs = new Set(outputTags);

  /**
   * The drafter behind every handler's `snapshot.draft`, read from the root
   * context on the sink's terms: once the context exists, then cached. Until
   * then (an async root layer, still building) the default drafts, which
   * only a custom drafter can tell apart.
   */
  let drafter: DrafterService | undefined;
  const drafterFor = (): DrafterService => {
    if (drafter !== undefined) return drafter;
    const context = runtime.cachedContext;
    if (context === undefined) return mutativeDrafter;
    drafter = Context.getUnsafe(context, Drafter);
    return drafter;
  };

  /**
   * A unit of work for the mount fiber.
   */
  type Work =
    | { readonly _tag: "Run"; readonly command: Command<any, any>; readonly ctx: CommandContext }
    | { readonly _tag: "Teardown"; readonly command: Command<any, any> | undefined }
    | { readonly _tag: "Settled" }
    /**
     * One diff of the declared set, computed in the fold and interpreted on
     * the mount fiber — the fork needs the mount's scope and services. Stops
     * first, awaited, then starts in record order.
     */
    | {
        readonly _tag: "Subscriptions";
        readonly stop: ReadonlyArray<string>;
        readonly start: ReadonlyArray<readonly [string, Subscription<any, any>]>;
      };

  type Mount = {
    readonly queue: Queue.Queue<Work>;
    readonly book: FiberBook;
    /** The second book: subscription fibers, never counted in `inFlight`. */
    readonly subscriptions: SubscriptionBook;
  };

  let mount: Mount | undefined;

  /**
   * The keys the last diff declared — the set the next diff is computed
   * against. Kept on the store rather than read off the mount's book: two
   * back-to-back dispatches fold before the mount fiber has interpreted the
   * first's `Subscriptions` item, so the book is stale at the second diff.
   * Cleared by `stop()` and when the mount dies.
   */
  let declared: ReadonlySet<string> = new Set();

  /**
   * Set by `start()` so the drain that folds `Mounted` reconciles whether or
   * not `Mounted` moved state. A re-arm calls `start()` from inside a fold,
   * where its `Mounted` is queued rather than folded, so the flag has to
   * outlive the call.
   */
  let dirty = false;

  const buffered: Array<Work> = [];
  const subscribers = new Set<() => void>();

  /**
   * Actions waiting to fold, each carrying the mount its commands must go to.
   * `target` is set for actions a command emitted — they belong to the mount
   * whose command emitted them, which during a teardown drain is not the
   * currently installed one. A plain `dispatch` carries none and routes to
   * whatever mount is live when it folds.
   */
  const pending: Array<{
    readonly action: { readonly _tag: string };
    readonly cause: DevtoolsCause;
    readonly target: Mount | undefined;
  }> = [];

  /**
   * Where the store is in its life. `idle` until the first `start`; `live`
   * while a mount is armed; `stopped` after `stop`, or after the mount fiber
   * ended; `dead` when the mount fiber died on its own — a feature layer that
   * failed to build — as opposed to being stopped, the one state in which new
   * work may re-arm the store (see `offer`). A `mount` is installed while
   * `live`, and stays installed after `stop` until its teardown drains.
   */
  let phase: "idle" | "live" | "stopped" | "dead" = "idle";
  let state = initialState(args.props);
  let props = args.props;
  let hooks: H | undefined;
  let folding = false;
  /**
   * Set while `sync` folds, so the drain's own subscription diff stands down
   * and `sync` diffs once after both of its folds. Notification is not
   * suppressed: a sync-driven fold that moved state has to reach
   * `useSyncExternalStore`, which is what re-renders the committed tree.
   */
  let syncing = false;

  const snapshot = (): Snapshot<Props, State, H> => ({
    state,
    props,
    hooks: hooks ?? ({} as H),
  });

  /**
   * Hand work to a mount. Before the first `start` it is buffered; after a
   * `stop` it is dropped; after the mount *died* it re-arms — but only for
   * work a `dispatch` produced. A layer failure folds `Error`, the handler
   * renders a Retry, and the click is the demand that rebuilds the layer.
   * Lifecycle- and command-caused work never re-arms: `Mounted`'s own command
   * would otherwise re-enter `start` from inside the fold `start` queued, and
   * a permanently failing layer would spin without anyone asking.
   */
  const offer = (work: Work, target: Mount | undefined, demand: boolean): boolean => {
    const to = target ?? mount;
    if (to !== undefined) {
      Queue.offerUnsafe(to.queue, work);
      return true;
    }
    if (phase === "idle") {
      buffered.push(work);
      return true;
    }
    if (phase === "dead" && demand) {
      start();
      // A layer that fails synchronously has already released the mount
      // again by the time `start` returns; the work is dropped and the
      // handler has its second `Error`.
      const rearmed = mount;
      if (rearmed === undefined) return false;
      Queue.offerUnsafe(rearmed.queue, work);
      return true;
    }
    return false;
  };

  const emitOutput = (action: { readonly _tag: string }, cause: DevtoolsCause): void => {
    report(() => ({ _tag: "Output", name, instance, cause, output: action }));

    try {
      emit(action);
    } catch (error) {
      report(() => ({
        _tag: "Defect",
        name,
        instance,
        cause,
        from: action._tag,
        defect: summarizeDefect(error),
        handled: false,
      }));
      defect(error);
    }
  };

  const foldOne = (
    action: { readonly _tag: string },
    cause: DevtoolsCause,
    routeTo: Mount | undefined,
  ): boolean => {
    if (outputs.has(action._tag)) {
      emitOutput(action, cause);
      return false;
    }

    const previous = state;
    const next = feature.reduce(action as never, snapshot(), drafterFor());
    const command = Next.command(next);
    const nextState = Next.state(next);
    const moved = nextState !== state;

    if (moved) state = nextState;

    report(() => ({
      _tag: "Transition",
      name,
      instance,
      cause,
      action: reportableAction(action, opaqueFields),
      previous,
      next: nextState,
    }));

    if (command) {
      const ctx = { tag: action._tag };
      const accepted = offer({ _tag: "Run", command, ctx }, routeTo, cause._tag === "Dispatch");
      report(() => ({
        _tag: "Command",
        name,
        instance,
        cause,
        group: ctx.tag,
        command: summarizeCommand(command),
        dropped: !accepted,
      }));
    }
    return moved;
  };

  const fold = (action: { readonly _tag: string }, cause: DevtoolsCause, target?: Mount): void => {
    pending.push({ action, cause, target });
    if (folding) return;

    folding = true;
    let moved = false;
    let last = pending[pending.length - 1];
    try {
      while (pending.length > 0) {
        const next = pending.shift()!;
        last = next;
        try {
          if (foldOne(next.action, next.cause, next.target)) moved = true;
        } catch (error) {
          raiseDefect(error, next.action._tag, next.cause, next.target);
        }
      }
    } finally {
      folding = false;
      if (moved) for (const subscriber of subscribers) subscriber();
      // Once per drain, against the settled state, outside the `folding`
      // guard: the hook is pure and `reconcile` offers rather than folds. A
      // `sync` reconciles itself, once, after its own folds.
      if ((moved || dirty) && !syncing) {
        dirty = false;
        reconcile(last.action._tag, last.cause);
      }
    }
  };

  /**
   * Evaluate the hook against the current snapshot and diff its keys against
   * `declared`: start `declared ∖ running`, stop `running ∖ declared`, leave
   * the rest alone. Only while a mount is live. The events are reported here,
   * synchronously, before any fiber runs; the work goes to the mount fiber.
   * A throwing hook is a defect `from` the action whose fold triggered the
   * diff, and the previous set stands.
   */
  function reconcile(from: string, cause: DevtoolsCause): void {
    if (!subscribes) return;
    const cells = mount;

    // A dead mount re-arms on demand, on `offer`'s rule: a dispatch whose
    // fold declares a key is work a dispatch produced, as much as a command
    // is. `start()` folds `Mounted` and reconciles from scratch against the
    // rebuilt layer, so nothing is diffed here. Lifecycle-, command- and
    // defect-caused folds never re-arm, for the reasons `offer` gives.
    if (cells === undefined || phase !== "live") {
      if (phase === "dead" && cause._tag === "Dispatch" && declares(from, cause)) start();
      return;
    }

    let next: Subscriptions<any, any>;
    try {
      next = feature.subscriptions(snapshot());
    } catch (error) {
      raiseDefect(error, from, cause, cells);
      return;
    }

    const { wanted, stopping, starting } = diffDeclared(declared, next);
    declared = wanted;
    if (stopping.length === 0 && starting.length === 0) return;

    for (const key of stopping) {
      report(() => ({
        _tag: "SubscriptionStopped",
        name,
        instance,
        cause,
        key,
        reason: "Undeclared",
      }));
    }
    for (const [key] of starting) {
      report(() => ({ _tag: "SubscriptionStarted", name, instance, cause, key }));
    }

    Queue.offerUnsafe(cells.queue, { _tag: "Subscriptions", stop: stopping, start: starting });
  }

  /** Whether the current snapshot declares any key. A throwing hook is a defect, as at a diff. */
  function declares(from: string, cause: DevtoolsCause): boolean {
    try {
      return declaredKeys(feature.subscriptions(snapshot())).length > 0;
    } catch (error) {
      raiseDefect(error, from, cause);
      return false;
    }
  }

  function raiseDefect(error: unknown, from: string, cause: DevtoolsCause, target?: Mount): void {
    const handled = from !== "Error" && handles("Error");

    report(() => ({
      _tag: "Defect",
      name,
      instance,
      cause,
      from,
      defect: summarizeDefect(error),
      handled,
    }));

    if (!handled) {
      defect(error);
      return;
    }

    fold(
      { _tag: "Error", error, cause: Cause.die(error), from } as never,
      { _tag: "Defect", from },
      target,
    );
  }

  const run = (cells: Mount) => {
    const release = (): void => {
      if (mount !== cells) return;
      mount = undefined;
      phase = "stopped";
    };

    const { interpret } = commandInterpreter({
      book: cells.book,
      emit: (message, ctx) => Effect.sync(() => fold(message, commandCause(ctx), cells)),
      settled: () => Queue.offerUnsafe(cells.queue, { _tag: "Settled" }),
      onExit: (exit, ctx) => {
        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
          raiseDefect(Cause.squash(exit.cause), ctx.tag, commandCause(ctx), cells);
        }
      },
    });

    // Stop the subscriptions, run the `Unmounted` command with services still
    // alive, then drain to quiescence: in-flight commands finish, and what
    // they emit folds. Nothing starts during a teardown, so a `Subscriptions`
    // item met in the drain is dropped.
    const teardown = (command: Command<any, any> | undefined) =>
      Effect.gen(function* () {
        yield* cells.subscriptions.stop(cells.subscriptions.keys());

        if (command !== undefined) {
          yield* interpret(command, { tag: "Unmounted" });
        }

        while (inFlight(cells.book) > 0 || Queue.sizeUnsafe(cells.queue) > 0) {
          const work = yield* Queue.take(cells.queue);
          if (work._tag === "Run") yield* interpret(work.command, work.ctx);
        }
      });

    const loop = Effect.gen(function* () {
      while (true) {
        const work = yield* Queue.take(cells.queue);

        if (work._tag === "Subscriptions") {
          yield* cells.subscriptions.stop(work.stop);
          for (const [key, sub] of work.start) yield* cells.subscriptions.fork(key, sub);
          continue;
        }

        if (work._tag === "Teardown") {
          yield* teardown(work.command).pipe(
            Effect.timeoutOption("5 seconds"),
            Effect.flatMap((finished) =>
              Option.isNone(finished)
                ? Effect.sync(() =>
                    raiseDefect(
                      new Error("Unmounted did not settle within 5s; scope closed anyway"),
                      "Unmounted",
                      LIFECYCLE,
                      cells,
                    ),
                  )
                : Effect.void,
            ),
          );
          return;
        }

        if (work._tag === "Settled") continue;

        yield* interpret(work.command, work.ctx);
      }
    });

    // `Effect.scoped` keeps the mount's own scope ambient, so a command's
    // `Effect.addFinalizer` lands on it and runs when the mount closes — inside
    // `Effect.provide`, so those finalizers run before the feature layer is
    // released. `provide` builds the layer once for the mount and releases it
    // when the loop ends; commands forked inside inherit its services, and a
    // layer that fails to build surfaces in `catchCause` below.
    const scoped = Effect.scoped(loop);
    return (layer === undefined ? scoped : Effect.provide(scoped, layer)).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasInterruptsOnly(cause)) return;
          // Only for the installed mount: a layer that fails after a remount
          // has already replaced its mount must not mark the live one dead or
          // forget its declared set. The defect is still reported.
          if (mount === cells) {
            mount = undefined;
            phase = "dead";
            // The subscriptions were children of the scope that just closed;
            // a re-arm through `start()` evaluates from scratch.
            declared = new Set();
          }
          raiseDefect(Cause.squash(cause), "Mounted", LIFECYCLE);
        }),
      ),
      Effect.ensuring(Effect.sync(release)),
    );
  };

  const start = (): void => {
    if (phase === "live") return;
    phase = "live";

    // `Queue.unbounded` captures the current fiber's dispatcher, so there is
    // no synchronous constructor to reach for; `runSync` of a sync effect is
    // exactly that constructor.
    // `dispatch` from a subscription folds into the mount that forked it, as
    // a command's does; the closures below run only once `cells` exists.
    const cells: Mount = {
      queue: Effect.runSync(Queue.unbounded<Work>()),
      book: new Map(),
      subscriptions: subscriptionBook({
        emit: (key, action) =>
          Effect.sync(() => fold(action, { _tag: "Subscription", key }, cells)),
        onExit: (key, exit) => {
          const cause: DevtoolsCause = { _tag: "Subscription", key };
          let reason: "Died" | "Completed" = "Completed";
          if (Exit.isFailure(exit)) {
            if (Cause.hasInterruptsOnly(exit.cause)) return;
            raiseDefect(Cause.squash(exit.cause), key, cause, cells);
            reason = "Died";
          }
          report(() => ({ _tag: "SubscriptionStopped", name, instance, cause, key, reason }));
        },
      }),
    };

    mount = cells;

    for (const work of buffered.splice(0)) Queue.offerUnsafe(cells.queue, work);
    runtime.runFork(run(cells));
    // The initial diff, whether or not `Mounted` moves state — honoured by the
    // drain that folds it, which is the outer one on the re-arm path.
    dirty = true;
    fold({ _tag: "Mounted" }, LIFECYCLE);
  };

  /**
   * The closure's counters, read on demand. What the stress and leak tests in
   * `*.stress.test.ts` assert against: a book that is empty after settle, a
   * `pending` that drained, a mount that is gone after `stop`.
   */
  const probe = (): StoreInternals => {
    let live = 0;
    if (mount !== undefined) {
      for (const group of mount.book.values()) {
        for (const fiber of group) if (fiber.pollUnsafe() === undefined) live += 1;
      }
    }
    const fibers = mount === undefined ? 0 : inFlight(mount.book);
    return {
      mounted: mount !== undefined,
      active: phase === "live",
      dead: phase === "dead",
      queued: mount === undefined ? 0 : Queue.sizeUnsafe(mount.queue),
      inFlight: fibers,
      groups: mount?.book.size ?? 0,
      fibers,
      live,
      subscriptions: mount?.subscriptions.size ?? 0,
      declared: declared.size,
      buffered: buffered.length,
      pending: pending.length,
      subscribers: subscribers.size,
    };
  };

  const store: FeatureStore<Props, State, Action, H, Output> = {
    subscribe: (onStoreChange) => {
      subscribers.add(onStoreChange);
      return () => void subscribers.delete(onStoreChange);
    },

    getSnapshot: () => state,

    dispatch: (message: unknown, payload?: unknown) => fold(toMessage(message, payload), DISPATCH),

    sync: (nextProps, nextHooks) => {
      const previousProps = props;
      const previousHooks = hooks;

      // Before the first `start` there is nothing to raise against: the
      // feature has folded no lifecycle action yet, so the latest props and
      // hooks are simply what `Mounted` will see. The same holds for the
      // first call after a hand-driven `start`, which seeds the hooks.
      if (phase === "idle" || previousHooks === undefined) {
        props = nextProps;
        hooks = nextHooks;
        return state;
      }

      const propsMoved = !equivalence.props(previousProps, nextProps);
      const hooksMoved = !equivalence.hooks(previousHooks, nextHooks);

      if (propsMoved) props = nextProps;
      if (hooksMoved) hooks = nextHooks;
      if (!propsMoved && !hooksMoved) return state;

      syncing = true;

      try {
        if (propsMoved) fold({ _tag: "PropsChanged", previous: previousProps } as never, LIFECYCLE);
        if (hooksMoved) fold({ _tag: "HookChanged", previous: previousHooks } as never, LIFECYCLE);
      } finally {
        syncing = false;
      }

      // Once, whether or not the handlers moved state: a key built from props
      // or hooks has to restart under the new value either way.
      reconcile(hooksMoved ? "HookChanged" : "PropsChanged", LIFECYCLE);

      return state;
    },

    start,

    stop: () => {
      // A dead mount has no fiber to tear down, but the component is going
      // away all the same: `Unmounted` still folds and is still reported, and
      // the phase leaves `dead` so a later dispatch drops instead of re-arming
      // a component React has already let go of.
      if (phase !== "live" && phase !== "dead") return;
      phase = "stopped";

      const cells = mount;

      // The declared set empties first, and its stops are reported before the
      // `Unmounted` transition: the console logger evicts the mount's elapsed
      // clock on that transition, and a later event would re-insert it. The
      // fibers themselves go on the mount fiber, first thing in the teardown.
      for (const key of declared) {
        report(() => ({
          _tag: "SubscriptionStopped",
          name,
          instance,
          cause: LIFECYCLE,
          key,
          reason: "Unmounted",
        }));
      }
      declared = new Set();

      let teardown: Command<any, any> | undefined;
      let thrown: { readonly error: unknown } | undefined;

      try {
        teardown = Next.command(
          feature.reduce({ _tag: "Unmounted" } as never, snapshot(), drafterFor()),
        );
      } catch (error) {
        thrown = { error };
      }

      if (cells !== undefined) {
        Queue.offerUnsafe(cells.queue, { _tag: "Teardown", command: teardown });
      }

      report(() => ({
        _tag: "Transition",
        name,
        instance,
        cause: LIFECYCLE,
        action: { _tag: "Unmounted" },
        previous: state,
        next: state,
      }));
      if (teardown !== undefined) {
        const command = teardown;
        report(() => ({
          _tag: "Command",
          name,
          instance,
          cause: LIFECYCLE,
          group: "Unmounted",
          command: summarizeCommand(command),
          dropped: cells === undefined,
        }));
      }

      if (thrown !== undefined) raiseDefect(thrown.error, "Unmounted", LIFECYCLE);
    },
  };

  return Object.assign(store, { [internals]: probe });
};

const splitOutputProps = (
  all: Record<string, unknown>,
  names: ReadonlySet<string>,
): { props: Record<string, unknown>; handlers: Record<string, (payload: unknown) => void> } => {
  // React's development build defines non-enumerable `key` (and, on 18, `ref`)
  // warning getters on the props of a keyed element. The props decoder reads
  // own property names and would report them as excess, so such an object is
  // copied through `Object.keys`, which skips them, instead of passed through.
  if (names.size === 0 && !Object.hasOwn(all, "key") && !Object.hasOwn(all, "ref")) {
    return { props: all, handlers: {} };
  }
  const props: Record<string, unknown> = {};
  const handlers: Record<string, (payload: unknown) => void> = {};
  for (const key of Object.keys(all)) {
    if (names.has(key)) handlers[key] = all[key] as (payload: unknown) => void;
    else props[key] = all[key];
  }
  return { props, handlers };
};

const hooksEquivalence = Equivalence.Record(
  Equivalence.strictEqual<unknown>(),
) as Equivalence.Equivalence<AnyHooks>;

const noHooks: AnyHooks = Object.freeze({});

/**
 * The `useFeature` context of every component name, at module level.
 *
 * Fast Refresh re-evaluates the file that calls `component()` on every save,
 * and React then re-renders the old fibers with the new function while a
 * fragment in another file still holds the old one. A context created inside
 * `component()` would differ between the two, and the fragment would throw
 * "called outside". This module is never re-evaluated by an app-file save, so
 * a context looked up here by `name` is the same on both sides.
 */
const snapshotContexts = new Map<
  string,
  ReactContext<RenderSnapshot<any, any, any, any> | undefined>
>();

const snapshotContextFor = (name: string) => {
  const existing = snapshotContexts.get(name);
  if (existing !== undefined) return existing;
  const created = createContext<RenderSnapshot<any, any, any, any> | undefined>(undefined);
  created.displayName = `${name}.Snapshot`;
  snapshotContexts.set(name, created);
  return created;
};

/**
 * Registers a component with React Fast Refresh, when a bundler exposes the
 * hook during module evaluation.
 *
 * The refresh Babel plugin registers `const X = component(x, …)` only when the
 * same file also renders `<X />`. Babel plugin-react, webpack's refresh
 * plugin and Next set `$RefreshReg$` on the global for the duration of a
 * module's evaluation, which is when `component()` runs, so the mount is
 * registered under its `name` even when nothing else in the file is. Where
 * the global is a stub (plugin-react outside a refresh boundary) or scoped to
 * the module (Vite+ and other rolldown-based plugins) this is a no-op. Two
 * `component()` calls with one `name` in one file share a refresh family.
 */
const registerWithFastRefresh = (type: unknown, name: string): void => {
  const reg = (globalThis as { $RefreshReg$?: (type: unknown, id: string) => void }).$RefreshReg$;
  if (typeof reg === "function") reg(type, name);
};

/**
 * What `component` returns: the mountable `FC`, carrying the one hook a view
 * fragment under it needs.
 *
 * `useFeature` returns the `RenderSnapshot` of the nearest enclosing mount of
 * a component with this `name` — the same `{ state, props, hooks, dispatch }`
 * object `render` received on that render — so a fragment split out of
 * `render` into its own file sees exactly what `render` sees, and nothing
 * more. Outside any such mount it throws, naming the component. The `name`
 * is the scope: two `component()` calls with one name share it, which is what
 * keeps a fragment working after Fast Refresh re-evaluates the file that made
 * the component.
 *
 *     export const Seed = component(seed, { name: "Seed" });
 *
 *     const Paginator = () => {
 *       const { state, dispatch } = Seed.useFeature();
 *       …
 *     };
 *
 * A fragment is part of its feature's view; a child *feature* is a `Feature`
 * of its own and talks through props and `on<Tag>`. A child feature reaching into an
 * ancestor's `useFeature` compiles, and hides that input from its own props
 * schema — documented as a smell, not prevented.
 */
export type FeatureComponent<
  Props,
  State,
  Action,
  Output extends { readonly _tag: string },
  H extends AnyHooks,
> = FC<Simplify<Props & OutputProps<Output>>> & {
  readonly useFeature: () => RenderSnapshot<Props, State, Action | Output, H>;
};

/**
 * The runtime is a root provider.
 */
export const createRuntime: <RootR, RootE>(
  layer: Layer.Layer<RootR, RootE>,
) => {
  readonly Provider: FC<{ readonly children?: ReactNode }>;

  readonly component: {
    <
      Props,
      State,
      Action,
      Output extends { readonly _tag: string },
      H extends AnyHooks,
      R extends RootR,
    >(
      feature: Feature<Props, State, Action, Output, H, R>,
      options: {
        /** The component's `displayName`, its devtools `name`, and the scope of `useFeature`. */
        readonly name: string;
      },
    ): FeatureComponent<Props, State, Action, Output, H>;

    <
      Props,
      State,
      Action,
      Output extends { readonly _tag: string },
      H extends AnyHooks,
      R,
      LayerError,
    >(
      feature: Feature<Props, State, Action, Output, H, R>,
      options: {
        readonly layer: Layer.Layer<Exclude<R, RootR>, LayerError, RootR>;
        /** The component's `displayName`, its devtools `name`, and the scope of `useFeature`. */
        readonly name: string;
      },
    ): FeatureComponent<Props, State, Action, Output, H>;
  };

  /**
   * Escape hatch for ordinary React components that are not features.
   */
  readonly useRuntime: () => ManagedRuntime.ManagedRuntime<RootR, RootE>;
} = (layer) => {
  const runtime = ManagedRuntime.make(layer);
  const context = createContext(runtime);

  const component = (
    feature: Feature<any, any, any, any, any, any>,
    componentOptions: { readonly layer?: Layer.Layer<any, any, any>; readonly name: string },
  ): FeatureComponent<any, any, any, any, any> => {
    const { render, useUnsafeHooks, props: propsSchema, outputTags } = feature[internals];
    const name = componentOptions?.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("component() needs a name");
    }

    // One context per `name`, from the module-level registry, so the identity
    // survives a re-evaluation of the calling module. Two names cannot see
    // each other's mounts; `undefined` is the no-mount signal `useFeature`
    // turns into a named throw.
    const Snapshot = snapshotContextFor(name);

    const useFeature = (): RenderSnapshot<any, any, any, any> => {
      const snapshot = useContext(Snapshot);
      if (snapshot === undefined) {
        throw new TypeError(`${name}.useFeature() called outside <${name}>`);
      }
      return snapshot;
    };
    const useFeatureHooks: HookSpec<any, any, AnyHooks> = useUnsafeHooks ?? (() => noHooks);
    const outputPropNames = new Set(outputTags.map((tag) => `on${tag}`));

    const equivalence = {
      props: Schema.toEquivalence(propsSchema) as Equivalence.Equivalence<Record<string, unknown>>,
      hooks: hooksEquivalence,
    };

    const decodeProps = SchemaParser.decodeUnknownSync(propsSchema, {
      onExcessProperty: "error",
      errors: "all",
    });

    // The parser's own throw says only "Schema validation failed", with the
    // issue in `cause` — useless at an error boundary. Every problem, with its
    // path, belongs in the message.
    const validateProps = (input: unknown): void => {
      try {
        decodeProps(input);
      } catch (error) {
        if (error instanceof Error && SchemaIssue.isIssue(error.cause)) {
          throw new TypeError(`Invalid props for <${name}>:\n${formatIssue(error.cause)}`, {
            cause: error.cause,
          });
        }
        throw error;
      }
    };

    const Mount: FC<Record<string, unknown>> = (incoming) => {
      const rootRuntime = useContext(context);

      const { props, handlers } = useMemo(
        () => splitOutputProps(incoming, outputPropNames),
        [incoming],
      );

      useMemo(() => validateProps(props), [props]);

      // Latest-ref, assigned in a layout effect: commit and layout effects run
      // in one synchronous task, so no command fiber's microtask can emit
      // between them and see the previous render's handler — the hole a
      // passive effect had. And unlike a render-phase assignment, a render
      // pass React abandons never assigns, so an emission can never invoke a
      // handler from a tree that was never committed.
      const handlersRef = useRef(handlers);
      useLayoutEffect(() => {
        handlersRef.current = handlers;
      });

      const [defect, setDefect] = useState<{ readonly error: unknown } | undefined>(undefined);
      if (defect) throw defect.error;

      const [store] = useState(() =>
        createFeatureStore({
          feature,
          props,
          equivalence,
          runtime: rootRuntime,
          layer: componentOptions.layer,
          emit: (output) => {
            const handler = handlerFor(handlersRef.current, `on${output._tag}`);
            if (!handler) {
              throw new TypeError(`No "on${output._tag}" prop for output "${output._tag}"`);
            }
            const { _tag, ...payload } = output as Record<string, unknown> & { _tag: string };
            handler(payload);
          },
          defect: (error) => setDefect({ error }),
          name,
        }),
      );

      // The third argument is the server snapshot: without it React throws
      // `Missing getServerSnapshot` under `renderToString`. The same reader is
      // correct on both sides: the server never folds (no effects run, so no
      // `start`), and hydration reads the same deterministic
      // `initialState(props)` the server rendered.
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

      // Against the state this render reads. A fold that moves state
      // re-renders synchronously, so a hook derived from state re-evaluates
      // against the new state before paint, and the layout effect below
      // raises `HookChanged` if its value moved.
      const hooks = useFeatureHooks(props, state);

      // In a layout effect, never in the body: the render body touches
      // nothing in the store, so a render React abandons (a suspended or
      // interrupted transition) costs the store nothing and never starts
      // work for props that did not commit. No dependency list: `sync`
      // compares props and hooks by value and is the dedupe. Layout rather
      // than passive: a fold that moves state makes `useSyncExternalStore`
      // schedule a synchronous re-render, which React flushes at the end of
      // this commit, so a props-driven change costs two renders and one
      // paint. Measured in `lib.browser.test.tsx`.
      useLayoutEffect(() => {
        store.sync(props, hooks);
      });

      // `Mounted` stays in an effect: it must not fire for a render React
      // throws away. `start`/`stop` rather than a single `dispose` lets the
      // StrictMode remount re-arm the store instead of inheriting a closed
      // scope.
      useEffect(() => {
        store.start();
        return () => store.stop();
      }, [store]);

      // One object for `render` and for the provider, so a fragment's
      // `useFeature()` is the snapshot `render` had, by identity. Fresh per
      // render, deliberately: consumers re-render with the root, which is the
      // set the root's own re-render already covers.
      const snapshot: RenderSnapshot<any, any, any, any> = {
        state,
        props,
        hooks,
        dispatch: store.dispatch,
      };

      return createElement(Snapshot.Provider, { value: snapshot }, render(snapshot));
    };

    Mount.displayName = name;
    registerWithFastRefresh(Mount, name);
    return Object.assign(Mount, { useFeature });
  };

  return Object.assign(
    {
      Provider: ({ children }: { readonly children?: ReactNode }) =>
        createElement(context.Provider, { value: runtime, children }),

      useRuntime: () => runtime,

      component: component as never,
    },
    // Test-only: the size of the module-level `useFeature` context registry,
    // which the leak tests hold to one entry per distinct `name`.
    { [internals]: { contexts: () => snapshotContexts.size } },
  );
};
