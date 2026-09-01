"use client";

import { LightningIcon } from "@phosphor-icons/react";
import sdk from "@stackblitz/sdk";
import { Button } from "@/components/ui/button";
import type { ExampleProject } from "@/lib/examples";

/**
 * Posts the example to stackblitz.com in a new tab. The SDK submits a form
 * synchronously from the click, so the tab is never popup-blocked; nothing
 * is fetched and nothing is stored on either side until the viewer forks.
 */
export function OpenInStackBlitz({ example }: { readonly example: ExampleProject }) {
  return (
    <Button
      size="sm"
      className="shadow-md shadow-black/15 dark:shadow-black/40"
      onClick={() =>
        sdk.openProject(example.project, { newWindow: true, openFile: example.openFile })
      }
    >
      <LightningIcon data-icon="inline-start" />
      Open in StackBlitz
    </Button>
  );
}
