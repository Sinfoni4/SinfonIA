import { EllipsisVertical } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';

import type * as React from 'react';

import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';

export type NavItem = { to: string; label: string; icon: React.ReactNode; end?: boolean };
export type NavGroup = { label: string; items: NavItem[] };

/** Whether a section is the current page: its own path or, unless `end`, one below it. */
function isCurrent(pathname: string, item: NavItem): boolean {
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/** The title of the bar on top: the section of the page (the longest path that matches). */
function sectionTitle(groups: NavGroup[], pathname: string, fallback: string): string {
  const match = groups
    .flatMap((g) => g.items)
    .filter((i) => i.to === pathname || pathname.startsWith(`${i.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return match?.label ?? fallback;
}

function initials(email: string | null): string {
  return email ? email.slice(0, 2).toUpperCase() : 'C';
}

/**
 * The frame of the dashboard and of the platform console, as the dashboard-01 block of shadcn/ui:
 * the sidebar (brand, a main action, the sections, a switch, the account) and beside it the bar
 * with the section and the page. Each panel gives its own content.
 */
export function AppFrame(props: {
  /** Name of the sidebar for screen readers. */
  sidebarLabel: string;
  /** Name of the navigation of the sections (tests and screen readers find it by name). */
  navLabel: string;
  brand: { to: string; icon: React.ReactNode; name: string };
  /** Under the brand: the organization, or what the console is. */
  context: React.ReactNode;
  /** The main action, in black above the sections. */
  action: { to: string; label: string; icon: React.ReactNode };
  groups: NavGroup[];
  /** At the foot of the sections: going to the other panel. */
  switcher?: React.ReactNode;
  account: { email: string | null; detail: string; menu: React.ReactNode };
  /** The badge on the right of the bar (the role, or «Console»). */
  badge: { label: string; tone?: 'console' };
  /** Title of the bar for pages outside the sections (e.g. the profile). */
  titles?: Record<string, string>;
  error?: string | null;
}) {
  return (
    <SidebarProvider>
      <a href="#contenuto" className="skip-link">
        Vai al contenuto
      </a>
      <Frame {...props} />
    </SidebarProvider>
  );
}

function Frame({
  sidebarLabel,
  navLabel,
  brand,
  context,
  action,
  groups,
  switcher,
  account,
  badge,
  titles = {},
  error,
}: React.ComponentProps<typeof AppFrame>) {
  const { setOpenMobile } = useSidebar();
  const { pathname } = useLocation();
  // FE5: after a change of page, keyboard and screen readers start from the new content.
  const main = useRef<HTMLElement>(null);
  const firstPage = useRef(true);
  useEffect(() => {
    setOpenMobile(false);
    if (firstPage.current) {
      firstPage.current = false;
      return;
    }
    main.current?.focus();
  }, [pathname, setOpenMobile]);

  const fallback = groups[0]?.items[0]?.label ?? '';
  const title = titles[pathname] ?? sectionTitle(groups, pathname, fallback);

  return (
    <>
      <Sidebar label={sidebarLabel}>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="p-1.5">
                <Link to={brand.to}>
                  {brand.icon}
                  <span className="text-base font-semibold">{brand.name}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <div className="flex flex-col gap-1.5 px-1.5">{context}</div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                >
                  <Link to={action.to}>
                    {action.icon}
                    <span>{action.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>

          <nav aria-label={navLabel} className="flex flex-col">
            {groups.map((group) => (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton asChild isActive={isCurrent(pathname, item)}>
                        <NavLink to={item.to} end={item.end}>
                          {item.icon}
                          <span>{item.label}</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            ))}
          </nav>

          {switcher && (
            <SidebarGroup className="mt-auto">
              <SidebarMenu>
                <SidebarMenuItem>{switcher}</SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          )}
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    size="lg"
                    className="data-[state=open]:bg-sidebar-accent"
                    aria-label={`Account: ${account.email ?? 'account della chat'}, ${account.detail}`}
                  >
                    <span
                      aria-hidden
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-xs font-semibold"
                    >
                      {initials(account.email)}
                    </span>
                    <span className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">
                        {account.email ?? 'Account della chat'}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {account.detail}
                      </span>
                    </span>
                    <EllipsisVertical aria-hidden className="ml-auto" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="end" className="w-56">
                  <DropdownMenuLabel className="flex flex-col font-normal">
                    <span className="truncate font-medium">
                      {account.email ?? 'Account della chat'}
                    </span>
                    <span className="text-xs text-muted-foreground">{account.detail}</span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {account.menu}
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header
          data-slot="site-header"
          className="flex h-(--header-height) shrink-0 items-center border-b border-border"
        >
          <div className="flex w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mx-2 h-4!" />
            <span className="truncate text-base font-medium">{title}</span>
            <Badge
              variant={badge.tone === 'console' ? 'warning' : 'secondary'}
              className="ml-auto shrink-0"
            >
              {badge.label}
            </Badge>
          </div>
        </header>
        {error && (
          <p className="error banner" role="alert">
            {error}
          </p>
        )}
        <main
          className="content w-full max-w-7xl px-4 py-4 md:py-6 lg:px-6"
          id="contenuto"
          tabIndex={-1}
          ref={main}
        >
          <Outlet />
        </main>
      </SidebarInset>
    </>
  );
}
