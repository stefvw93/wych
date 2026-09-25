/**
 * The `@wych/internals` probes, the way the internals test in `lib.test.ts`
 * reads them: no named export of the library exists for them. Browser-safe;
 * `stress.ts` re-exports these beside its node-only helpers.
 */

export const MiB = 1024 * 1024;

export interface StoreProbe {
  readonly mounted: boolean;
  readonly active: boolean;
  readonly dead: boolean;
  readonly queued: number;
  readonly inFlight: number;
  readonly groups: number;
  readonly fibers: number;
  readonly live: number;
  readonly subscriptions: number;
  readonly declared: number;
  readonly buffered: number;
  readonly pending: number;
  readonly subscribers: number;
}

const slotOf = (target: object): symbol => {
  const slot = Object.getOwnPropertySymbols(target).find(
    (symbol) => symbol.description === "@wych/internals",
  );
  if (slot === undefined) throw new TypeError("no @wych/internals slot on the target");
  return slot;
};

/** The store's closure counters, read now. */
export const probe = (store: object): StoreProbe =>
  (store as Record<symbol, () => StoreProbe>)[slotOf(store)]();

/** The size of the module-level `useFeature` context registry. */
export const contexts = (runtime: object): number =>
  (runtime as Record<symbol, { readonly contexts: () => number }>)[slotOf(runtime)].contexts();

/** A probe that is empty of work: nothing booked, nothing queued. */
export const idle = (p: StoreProbe): boolean =>
  p.queued === 0 &&
  p.inFlight === 0 &&
  p.fibers === 0 &&
  p.groups === 0 &&
  p.pending === 0 &&
  p.buffered === 0 &&
  p.subscriptions === 0;
