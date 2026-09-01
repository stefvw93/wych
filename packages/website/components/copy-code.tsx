"use client";

import { useEffect } from "react";

/**
 * Wires every `[data-copy-code]` button the markdown renderer emitted. One
 * delegated listener rather than a component per block: the blocks are
 * static HTML from `dangerouslySetInnerHTML`, so there is nothing to mount
 * into.
 */
export function CopyCode() {
  useEffect(() => {
    const onClick = async (event: MouseEvent) => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-copy-code]");
      const code = button?.parentElement?.querySelector("pre")?.textContent;
      if (!button || code === undefined || code === null) return;
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        return;
      }
      button.dataset.copied = "";
      button.setAttribute("aria-label", "Copied");
      window.setTimeout(() => {
        delete button.dataset.copied;
        button.setAttribute("aria-label", "Copy code");
      }, 1500);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}
