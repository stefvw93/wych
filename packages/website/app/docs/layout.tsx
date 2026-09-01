import { GithubLogoIcon, HouseIcon } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { DocsSidebarNav } from "@/components/docs-sidebar-nav";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { docsBySection } from "@/lib/docs";
import { site } from "@/lib/site";

export default async function DocsLayout({ children }: LayoutProps<"/docs">) {
  const sections = (await docsBySection()).map((section) => ({
    title: section.title,
    items: section.docs.map((doc) => ({ href: `/docs/${doc.slug}`, title: doc.title })),
  }));

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                className="font-heading font-medium"
                render={<Link href="/docs" />}
              >
                {site.name}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <DocsSidebarNav sections={sections} />
        </SidebarContent>
        <SidebarFooter>
          <p className="px-2 text-xs leading-5 text-muted-foreground">
            These pages ship with the package. See{" "}
            <Link
              href="/docs/how-to/use-with-ai-agents"
              className="underline underline-offset-2 hover:text-foreground"
            >
              using with AI agents
            </Link>
            .
          </p>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4! self-center!" />
          <Button
            variant="ghost"
            size="icon-sm"
            nativeButton={false}
            aria-label="Home"
            render={<Link href="/" />}
          >
            <HouseIcon />
          </Button>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon-sm"
            nativeButton={false}
            aria-label="GitHub"
            render={<a href={site.github} target="_blank" rel="noreferrer" />}
          >
            <GithubLogoIcon />
          </Button>
        </header>
        <div className="mx-auto w-full min-w-0 max-w-3xl flex-1 px-6 py-10 md:px-10">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
