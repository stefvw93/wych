"use client";

import { useEffect, useState } from "react";
import type { Heading } from "@/lib/docs";
import { cn } from "@/lib/utils";

/**
 * "On this page" rail. The active entry is the last heading that has
 * scrolled past the sticky header, so it tracks the section being read
 * rather than the one whose heading is merely on screen.
 */
export function Toc({ headings }: { readonly headings: readonly Heading[] }) {
  const [active, setActive] = useState<string | undefined>(headings[0]?.id);

  useEffect(() => {
    const elements = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const update = () => {
      // Matches `scroll-mt-20` on the headings, plus a little slack.
      const line = 96;
      let current = elements[0];
      for (const el of elements) {
        if (el.getBoundingClientRect().top <= line) current = el;
        else break;
      }
      setActive(current?.id);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <nav aria-label="On this page" className="text-sm">
      <p className="mb-3 font-heading text-xs font-medium text-muted-foreground">On this page</p>
      <ul className="flex flex-col gap-1.5 border-l border-border">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              aria-current={active === h.id ? "location" : undefined}
              className={cn(
                "-ml-px block border-l border-transparent py-0.5 pl-3 leading-5 text-muted-foreground transition-colors hover:text-foreground",
                h.depth === 3 && "pl-6",
                active === h.id && "border-foreground text-foreground",
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
