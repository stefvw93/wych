"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

export interface NavItem {
  readonly href: string;
  readonly title: string;
}

export interface NavSection {
  readonly title: string;
  readonly items: readonly NavItem[];
}

/**
 * The docs nav. A client component only because the active item needs the
 * current pathname; the sections come from the server as plain data.
 */
export function DocsSidebarNav({ sections }: { readonly sections: readonly NavSection[] }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  return sections.map((section) => (
    <SidebarGroup key={section.title}>
      <SidebarGroupLabel>{section.title}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {section.items.map((item) => (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                isActive={pathname === item.href}
                render={<Link href={item.href} onClick={() => setOpenMobile(false)} />}
              >
                {item.title}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  ));
}
