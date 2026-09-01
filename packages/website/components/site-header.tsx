import { GithubLogoIcon } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { site } from "@/lib/site";

/** Top bar for pages outside the docs shell. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-12 w-full max-w-5xl items-center justify-between px-6">
        <Link href="/" className="font-heading text-sm font-medium">
          {site.name}
        </Link>
        <nav className="flex items-center gap-1">
          <Button variant="ghost" nativeButton={false} render={<Link href="/docs" />}>
            Docs
          </Button>
          <Button
            variant="ghost"
            size="icon"
            nativeButton={false}
            aria-label="GitHub"
            render={<a href={site.github} target="_blank" rel="noreferrer" />}
          >
            <GithubLogoIcon />
          </Button>
        </nav>
      </div>
    </header>
  );
}
