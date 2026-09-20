/**
 * The DOM harness every browser suite shares: one container per test, mounted
 * and unmounted inside `act`, and the three reads a test makes against it.
 * Importing this module registers the `afterEach` that unmounts.
 */
import { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vite-plus/test";

// `act` needs this flag to actually batch; without it React warns and a
// "one render, not two" assertion would pass for the wrong reason.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Minimal boundary, so a thrown defect is observable instead of unmounting the tree. */
export class ErrorBoundary extends Component<
  { readonly children?: ReactNode; readonly onError: (error: unknown) => void },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

let root: Root | undefined;
let current: HTMLDivElement | undefined;

/** Render `element` into a fresh container under `document.body`. */
export const mount = async (element: ReactNode): Promise<HTMLDivElement> => {
  current = document.createElement("div");
  document.body.append(current);
  root = createRoot(current);
  await act(async () => root!.render(element));
  return current;
};

/** Unmount inside `act` and drop the container. Safe to call with nothing mounted. */
export const unmount = async (): Promise<void> => {
  if (root) await act(async () => root!.unmount());
  current?.remove();
  root = undefined;
  current = undefined;
};

afterEach(unmount);

/** The mounted container. Throws when nothing is mounted. */
export const container = (): HTMLDivElement => {
  if (current === undefined) throw new Error("nothing mounted");
  return current;
};

/** The text under `data-testid`, or `""`. */
export const text = (testId: string): string =>
  current?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";

/** Click the element under `data-testid`, inside `act`. */
export const click = async (testId: string): Promise<void> => {
  const element = current?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  await act(async () => element?.click());
};

/**
 * Let forked fibers run, inside `act`: a fork lands on the scheduler after
 * the `act` that caused it resolves, so what it dispatches would otherwise
 * update React outside `act`.
 */
export const flush = (ms = 30): Promise<void> =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
