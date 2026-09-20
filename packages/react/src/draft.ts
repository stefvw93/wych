import { Context, Layer } from "effect";
import { create } from "mutative";

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/**
 * A mutable view of `T`, what `snapshot.draft` hands a reducer handler.
 *
 * Primitives, functions and anything carrying a `pipe` method (every Effect
 * data type: `Option`, `Chunk`, `Effect` itself) pass through unchanged.
 * Arrays and plain objects lose `readonly`, recursively. Same key set as `T`,
 * so a draft is assignable to `T` and `Exhaustive` sees no excess.
 */
export type Draft<T> = T extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | ((...args: never) => unknown)
  ? T
  : T extends { readonly pipe: unknown }
    ? T
    : T extends ReadonlyArray<infer E>
      ? Array<Draft<E>>
      : T extends object
        ? { -readonly [K in keyof T]: Draft<T[K]> }
        : T;

/**
 * One open draft: the proxy and the call that closes it. `finish` returns
 * the base by reference when nothing was written, a new frozen value
 * otherwise, and revokes the proxy either way.
 */
export interface DraftHandle<T> {
  readonly draft: Draft<T>;
  readonly finish: () => T;
}

/**
 * What makes a draft. One method, so an implementation is a literal: Immer
 * is `createDraft` and `finishDraft` in four lines.
 */
export interface DrafterService {
  readonly create: <T>(base: T) => DraftHandle<T>;
}

// ---------------------------------------------------------------------------
// The default and the service
// ---------------------------------------------------------------------------

/**
 * The default drafter: Mutative with auto-freeze, so a state that went
 * through a draft is deep-frozen afterwards and a write outside a handler
 * throws in strict mode.
 */
export const mutativeDrafter: DrafterService = {
  create: <T>(base: T): DraftHandle<T> => {
    const [draft, finalize] = create(base as object, { enableAutoFreeze: true });
    return { draft: draft as Draft<T>, finish: finalize as () => T };
  },
};

/**
 * The draft mechanism behind `snapshot.draft`, on the same terms as
 * `Devtools`: a `Context.Reference`, so reading it is total and installing
 * one widens nothing. `mutativeDrafter` unless the root layer says
 * otherwise.
 */
export const Drafter: Context.Reference<DrafterService> = Context.Reference<DrafterService>(
  "@wych/Drafter",
  { defaultValue: () => mutativeDrafter },
);

/** A custom drafter as a root layer: `Layer.mergeAll(AppLayer, drafterLayer(immerDrafter))`. */
export const drafterLayer = (drafter: DrafterService): Layer.Layer<never> =>
  Layer.succeed(Drafter)(drafter);

// ---------------------------------------------------------------------------
// Open drafts
// ---------------------------------------------------------------------------

/**
 * The drafts open on a fold right now. A proxy cannot be branded without
 * recording a write, so `Task.start` asks here whether the state it was
 * handed is a draft. A `WeakSet`: a draft is removed at `closeDraft` and
 * never retained.
 */
const live = new WeakSet<object>();

/** @internal Whether `value` is a draft open on the current fold. */
export const isLiveDraft = (value: unknown): value is object =>
  typeof value === "object" && value !== null && live.has(value);

/** @internal Open a draft over `base` and book it as live. */
export const openDraft = <T>(drafter: DrafterService, base: T): DraftHandle<T> => {
  const handle = drafter.create(base);
  live.add(handle.draft as object);
  return handle;
};

/** @internal Unbook and finish a draft. Total for a well-behaved drafter. */
export const closeDraft = <T>(handle: DraftHandle<T>): T => {
  live.delete(handle.draft as object);
  return handle.finish();
};
