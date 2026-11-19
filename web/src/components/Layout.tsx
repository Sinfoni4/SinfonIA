import {
  AudioLines,
  Building2,
  CalendarClock,
  ChartColumn,
  CirclePlus,
  Download,
  EllipsisVertical,
  FileSearch,
  FolderOpen,
  Handshake,
  History,
  Inbox,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Network,
  Settings,
  ShieldCheck,
  SquareKanban,
  UserRound,
  Users,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';

import { describeError, ROLE_LABELS, type Me } from '../api/client';
import { NETWORK_TYPES } from '../api/organization';
import { useSession } from '../session/session';

import type * as React from 'react';

import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NativeSelect } from '@/components/ui/native-select';
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

type Item = { to: string; label: string; icon: React.ReactNode; show?: boolean };

/** Whether a section is the current page: its own path or one below it (Home only itself). */
function isCurrent(pathname: string, to: string): boolean {
  if (to === '/' || to === '/rete') return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** The sections of the organization, grouped as the sidebar shows them; hidden ones dropped. */
function sections(me: Me): Array<{ label: string; items: Item[] }> {
  const current = me.organizations.find((o) => o.orgId === me.current.orgId);
  // MF9: the sections of a network (G5); the backend refuses them to other types anyway.
  const isNetwork = current?.type !== undefined && NETWORK_TYPES.includes(current.type);
  const staff = me.current.role !== 'MEMBER';
  const admin = me.current.role === 'ADMIN';
  // A03: a function turned off for the organization is not offered (the backend refuses it).
  const on = (feature: string) => !(me.current.disabledFeatures ?? []).includes(feature);
  const groups = [
    {
      label: 'Lavoro',
      items: [
        { to: '/', label: 'Home', icon: <LayoutDashboard aria-hidden /> },
        { to: '/pratiche', label: 'Pratiche', icon: <FolderOpen aria-hidden /> },
        { to: '/bacheca', label: 'Bacheca', icon: <SquareKanban aria-hidden />, show: staff },
        {
          to: '/scadenze',
          label: 'Scadenze',
          icon: <CalendarClock aria-hidden />,
          show: on('deadlines'),
        },
        {
          to: '/verifica',
          label: 'Da verificare',
          icon: <FileSearch aria-hidden />,
          show: on('documents'),
        },
        {
          to: '/richieste',
          label: 'Richieste',
          icon: <Inbox aria-hidden />,
          show: staff && on('documents'),
        },
        {
          to: '/assistenza',
          label: 'Assistenza',
          icon: <LifeBuoy aria-hidden />,
          show: staff && on('assistance'),
        },
      ],
    },
    {
      label: 'Strumenti',
      items: [
        { to: '/export', label: 'Export', icon: <Download aria-hidden />, show: on('exports') },
        {
          to: '/deleghe',
          label: 'Deleghe',
          icon: <Handshake aria-hidden />,
          show: on('delegations'),
        },
        {
          to: '/rete/statistiche',
          label: 'Statistiche',
          icon: <ChartColumn aria-hidden />,
          show: isNetwork && staff && on('network_stats'),
        },
      ],
    },
    {
      label: 'Amministrazione',
      items: [
        { to: '/persone', label: 'Persone', icon: <Users aria-hidden />, show: admin },
        { to: '/rete', label: 'Aderenti', icon: <Network aria-hidden />, show: admin && isNetwork },
        { to: '/adesioni', label: 'Adesioni', icon: <Building2 aria-hidden />, show: admin },
        { to: '/attivita', label: 'Attività', icon: <History aria-hidden />, show: admin },
        { to: '/impostazioni', label: 'Impostazioni', icon: <Settings aria-hidden />, show: admin },
      ],
    },
  ];
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => i.show !== false) }))
    .filter((g) => g.items.length > 0);
}

/** The title of the bar on top: the section the page belongs to. */
function sectionTitle(groups: Array<{ items: Item[] }>, pathname: string): string {
  if (pathname === '/profilo') return 'Profilo';
  const items = groups.flatMap((g) => g.items);
  // The longest match wins: «Statistiche» (/rete/statistiche) over «Aderenti» (/rete).
  const match = items
    .filter((i) => i.to === pathname || (i.to !== '/' && pathname.startsWith(`${i.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return match?.label ?? 'Home';
}

function initials(email: string | null): string {
  if (!email) return 'C';
  return email.slice(0, 2).toUpperCase();
}

/**
 * The dashboard of an organization in the layout of the dashboard-01 block of shadcn/ui: the
 * sidebar (organization, sections, account) and, beside it, the bar with the section and the page.
 */
export function Layout({ me }: { me: Me }) {
  return (
    <SidebarProvider>
      <a href="#contenuto" className="skip-link">
        Vai al contenuto
      </a>
      <Shell me={me} />
    </SidebarProvider>
  );
}

function Shell({ me }: { me: Me }) {
  const { enter, enterPlatform, logout } = useSession();
  const { setOpenMobile } = useSidebar();
  const [error, setError] = useState<string | null>(null);
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

  const current = me.organizations.find((o) => o.orgId === me.current.orgId);
  const groups = sections(me);
  const role = ROLE_LABELS[me.current.role];

  const switchTo = async (orgId: string) => {
    setError(null);
    try {
      await enter(orgId);
    } catch (err: unknown) {
      setError(describeError(err));
    }
  };

  return (
    <>
      <Sidebar label="Menu della dashboard">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="p-1.5">
                <Link to="/">
                  <AudioLines aria-hidden className="size-5!" />
                  <span className="text-base font-semibold">SinfonIA</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <div className="flex flex-col gap-1.5 px-1.5">
            {me.organizations.length > 1 ? (
              <NativeSelect
                className="w-full"
                value={me.current.orgId}
                onChange={(e) => void switchTo(e.target.value)}
                aria-label="Azienda"
              >
                {me.organizations.map((o) => (
                  <option key={o.orgId} value={o.orgId}>
                    {o.name}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <span className="truncate text-sm font-medium">{current?.name}</span>
            )}
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                >
                  <Link to="/pratiche/nuova">
                    <CirclePlus aria-hidden />
                    <span>Nuova pratica</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>

          <nav aria-label="Sezioni" className="flex flex-col">
            {groups.map((group) => (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton asChild isActive={isCurrent(pathname, item.to)}>
                        <NavLink to={item.to} end={item.to === '/' || item.to === '/rete'}>
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

          {me.platform && (
            <SidebarGroup className="mt-auto">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() =>
                      void enterPlatform().catch((err: unknown) => setError(describeError(err)))
                    }
                  >
                    <ShieldCheck aria-hidden />
                    <span>Console</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
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
                    aria-label={`Account: ${me.email ?? 'account della chat'}, ${role}`}
                  >
                    <span
                      aria-hidden
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-xs font-semibold"
                    >
                      {initials(me.email)}
                    </span>
                    <span className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">
                        {me.email ?? 'Account della chat'}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">{role}</span>
                    </span>
                    <EllipsisVertical aria-hidden className="ml-auto" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="end" className="w-56">
                  <DropdownMenuLabel className="flex flex-col font-normal">
                    <span className="truncate font-medium">{me.email ?? 'Account della chat'}</span>
                    <span className="text-xs text-muted-foreground">{current?.name}</span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/profilo">
                      <UserRound aria-hidden />
                      Profilo
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void logout()}>
                    <LogOut aria-hidden />
                    Esci
                  </DropdownMenuItem>
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
            <span className="truncate text-base font-medium">{sectionTitle(groups, pathname)}</span>
            <Badge variant="secondary" className="ml-auto shrink-0">
              {role}
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
