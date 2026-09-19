"use client";

import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";

/**
 * Effect, @wych/react, minisearch and the index all live behind this import,
 * so a page that never opens search never downloads them.
 */
const SearchDialog = dynamic(() => import("@/features/search"), { ssr: false });

const SHORTCUT = "k";

const subscribeNever = () => () => {};
const isMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);
/** Server snapshot: unknown platform, so the server and the hydrating render agree. */
const unknownPlatform = () => undefined;

/** Search button plus the cmd/ctrl+K binding; mounts the dialog on first open. */
export function SearchTrigger() {
  const mac = React.useSyncExternalStore(subscribeNever, isMac, unknownPlatform);
  const [open, setOpen] = React.useState(false);
  const [opened, setOpened] = React.useState(false);
  const pathname = usePathname();
  const [prevPathname, setPrevPathname] = React.useState(pathname);

  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setOpen(false);
  }

  const show = React.useCallback(() => {
    setOpened(true);
    setOpen(true);
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpened(true);
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 text-muted-foreground max-sm:size-7 max-sm:px-0"
        onClick={show}
        aria-label="Search docs"
        aria-keyshortcuts={mac === undefined ? undefined : mac ? "Meta+K" : "Control+K"}
      >
        <MagnifyingGlassIcon className="size-3.5" />
        <span className="max-sm:sr-only">Search</span>
        <kbd
          className="ml-1 hidden rounded-none border bg-muted px-1 font-mono text-[10px] sm:inline"
          aria-hidden="true"
        >
          {mac === undefined ? "" : mac ? "⌘K" : "Ctrl K"}
        </kbd>
      </Button>
      {opened ? <SearchDialog open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}
