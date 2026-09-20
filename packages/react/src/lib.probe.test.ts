import { Cause, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vite-plus/test";

/**
 * Runtime properties of the installed `effect` version that the command
 * interpreter and the subscription book rely on. Not library tests: a failure
 * here after an `effect` bump means the runtime's assumptions moved, and the
 * step named in each probe has to be revisited before anything else.
 *
 * The interpreter observes a fiber's exit through `fiber.addObserver`, attached
 * right after `Effect.forkChild`, in place of a second watcher fiber on
 * `Fiber.await`. Three properties make that sound.
 */
describe("effect runtime probes", () => {
  /**
   * Step A2, `forkLeaf`: a fiber interrupted before the scheduler has run it
   * never executes its body, so an `Effect.ensuring` inside the body cannot be
   * the bookkeeping. The observer fires anyway, synchronously, inside the
   * interrupt, with an interrupts-only cause.
   */
  it("P1 · a pre-start interrupt skips the body and fires the observer synchronously", async () => {
    let ran = false;
    let ensured = false;
    const exits: Array<Exit.Exit<void>> = [];
    let firedBeforeInterruptReturned = false;

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.sync(() => {
            ran = true;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ensured = true;
              }),
            ),
          ),
        );
        fiber.addObserver((exit) => {
          exits.push(exit);
        });
        yield* Fiber.interrupt(fiber);
        firedBeforeInterruptReturned = exits.length === 1;
      }),
    );

    expect(ran).toBe(false);
    expect(ensured).toBe(false);
    expect(exits).toHaveLength(1);
    expect(firedBeforeInterruptReturned).toBe(true);
    expect(Exit.isFailure(exits[0]!) && Cause.hasInterruptsOnly(exits[0]!.cause)).toBe(true);
  });

  /**
   * Step A2, `subscriptionBook.fork`: an observer attached after the fiber has
   * already exited is called at attach with that exit. A death between the
   * fork and the attach is therefore never lost, so the fiber does not need
   * to book itself from inside its own body.
   */
  it("P2 · an observer attached after the exit fires at attach with that exit", async () => {
    const boom = new Error("boom");
    const exits: Array<Exit.Exit<void>> = [];
    let firedAtAttach = false;

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.die(boom));
        yield* Effect.yieldNow;
        expect(fiber.pollUnsafe()).toBeDefined();
        fiber.addObserver((exit) => {
          exits.push(exit);
        });
        firedAtAttach = exits.length === 1;
      }),
    );

    expect(firedAtAttach).toBe(true);
    expect(Exit.isFailure(exits[0]!) && Cause.squash(exits[0]!.cause)).toBe(boom);
  });

  /**
   * Step A2, both books: an interrupt of a running uninterruptible region is
   * deferred, and the observer fires exactly once, after the region ends.
   * The interpreter's `Cancel` awaits `Fiber.interruptAll`, so a fiber that
   * dies while its key is being stopped can still report after its stop; the
   * `book.get(key) === self` guard is what silences it.
   */
  it("P3 · an interrupt inside an uninterruptible region fires the observer once, afterwards", async () => {
    const exits: Array<Exit.Exit<void>> = [];
    let regionEnded = false;
    let firedBeforeRegionEnded = false;

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.uninterruptible(
            Effect.sleep("10 millis").pipe(
              Effect.andThen(
                Effect.sync(() => {
                  regionEnded = true;
                }),
              ),
            ),
          ),
        );
        yield* Effect.yieldNow;
        fiber.addObserver((exit) => {
          if (!regionEnded) firedBeforeRegionEnded = true;
          exits.push(exit);
        });
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(regionEnded).toBe(true);
    expect(firedBeforeRegionEnded).toBe(false);
    expect(exits).toHaveLength(1);
    expect(Exit.isFailure(exits[0]!) && Cause.hasInterruptsOnly(exits[0]!.cause)).toBe(true);
  });
});
