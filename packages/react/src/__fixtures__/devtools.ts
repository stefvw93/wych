/**
 * Reads over a recorder's event stream. Browser-safe: no node imports.
 */
import type { DevtoolsEvent, DevtoolsRecorder } from "../devtools";

/** The events with this `_tag`, narrowed. */
export const tagged = <Tag extends DevtoolsEvent["_tag"]>(
  events: ReadonlyArray<DevtoolsEvent>,
  tag: Tag,
): ReadonlyArray<Extract<DevtoolsEvent, { readonly _tag: Tag }>> =>
  events.filter(
    (event): event is Extract<DevtoolsEvent, { readonly _tag: Tag }> => event._tag === tag,
  );

/** The transitions folded for this action tag. */
export const transitions = (events: ReadonlyArray<DevtoolsEvent>, actionTag: string) =>
  tagged(events, "Transition").filter((event) => event.action._tag === actionTag);

/** The two reads bound to one recorder, for a suite that has a single one. */
export const query = (recorder: DevtoolsRecorder) =>
  ({
    tagged: <Tag extends DevtoolsEvent["_tag"]>(tag: Tag) => tagged(recorder.events, tag),
    transitions: (actionTag: string) => transitions(recorder.events, actionTag),
  }) as const;
