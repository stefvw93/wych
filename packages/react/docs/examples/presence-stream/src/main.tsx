import { createRuntime } from "@wych/react";
import { Effect, Layer, Stream } from "effect";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { presence } from "./presence";
import { PresenceApi } from "./presence-api";

// A fake feed: every second one person in the room comes online or goes offline.
const rooms: Record<string, ReadonlyArray<string>> = {
  general: ["ada", "grace", "linus"],
  random: ["margaret", "dennis", "ken"],
};

const live = Layer.succeed(PresenceApi)({
  events: (roomId) => {
    const people = rooms[roomId] ?? [];
    return Stream.tick("1 second").pipe(
      Stream.zipWithIndex,
      Stream.map(([, index]) => ({
        userId: people[index % people.length],
        online: Math.floor(index / people.length) % 2 === 0,
      })),
    );
  },
});

const { component } = createRuntime(live);

const Room = component(presence, { name: "Presence" });

// The room switcher is plain React state. A changed `roomId` reaches the
// feature as a new key from `subscriptions`, which stops the old room's
// fiber and starts the new one. No lifecycle handler is involved.
const App = () => {
  const [roomId, setRoomId] = useState("general");
  return (
    <main>
      {Object.keys(rooms).map((id) => (
        <button key={id} disabled={id === roomId} onClick={() => setRoomId(id)}>
          #{id}
        </button>
      ))}
      <h2>Online in #{roomId}</h2>
      <Room roomId={roomId} />
    </main>
  );
};

createRoot(document.getElementById("root")!).render(<App />);

// A finite stream completes on its own, so `run` resolves with no `Unmounted`.
const twoEvents = Layer.succeed(PresenceApi)({
  events: () =>
    Stream.fromArray([
      { userId: "ada", online: true },
      { userId: "grace", online: true },
    ]),
});

const result = await Effect.runPromise(
  presence.run([{ _tag: "Mounted" }], {
    props: { roomId: "general" },
    hooks: {},
    layer: twoEvents,
  }),
);
console.log(result.state);
// => { online: ["ada", "grace"] }
console.log(result.emitted);
// => [
//      { _tag: "Changed", userId: "ada", online: true },
//      { _tag: "Changed", userId: "grace", online: true },
//    ]
console.log(result.subscriptions);
// => ["presence:general"]

// An endless feed resolves too: a subscription counts for nothing toward
// quiescence, unlike a command. `run` interrupts it before returning.
const endless = Layer.succeed(PresenceApi)({ events: () => Stream.never });

const stillResolves = await Effect.runPromise(
  presence.run([{ _tag: "Mounted" }], {
    props: { roomId: "general" },
    hooks: {},
    layer: endless,
  }),
);
console.log(stillResolves.subscriptions);
// => ["presence:general"]
