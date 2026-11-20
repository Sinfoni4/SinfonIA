import {
  AudioLines,
  Building2,
  CalendarClock,
  ChartColumn,
  CirclePlus,
  Download,
  FileSearch,
  FolderOpen,
  Handshake,
  History,
  Inbox,
  Layers,
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
import { useState } from 'react';
import { Link } from 'react-router';

import { describeError, ROLE_LABELS, type Me } from '../api/client';
import { NETWORK_TYPES } from '../api/organization';
import { useSession } from '../session/session';

import { AppFrame, type NavGroup, type NavItem } from './AppFrame';

import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { NativeSelect } from '@/components/ui/native-select';
import { SidebarMenuButton } from '@/components/ui/sidebar';

/** The sections of the organization, grouped as the sidebar shows them; hidden ones dropped. */
function sections(me: Me): NavGroup[] {
  const current = me.organizations.find((o) => o.orgId === me.current.orgId);
  // MF9: the sections of a network (G5); the backend refuses them to other types anyway.
  const isNetwork = current?.type !== undefined && NETWORK_TYPES.includes(current.type);
  const staff = me.current.role !== 'MEMBER';
  const admin = me.current.role === 'ADMIN';
  // A03: a function turned off for the organization is not offered (the backend refuses it).
  const on = (feature: string) => !(me.current.disabledFeatures ?? []).includes(feature);
  const item = (show: boolean, i: NavItem) => (show ? [i] : []);
  const groups: NavGroup[] = [
    {
      label: 'Lavoro',
      items: [
        { to: '/', label: 'Home', icon: <LayoutDashboard aria-hidden />, end: true },
        { to: '/pratiche', label: 'Pratiche', icon: <FolderOpen aria-hidden /> },
        ...item(staff, { to: '/bacheca', label: 'Bacheca', icon: <SquareKanban aria-hidden /> }),
        ...item(on('deadlines'), {
          to: '/scadenze',
          label: 'Scadenze',
          icon: <CalendarClock aria-hidden />,
        }),
        ...item(on('documents'), {
          to: '/verifica',
          label: 'Da verificare',
          icon: <FileSearch aria-hidden />,
        }),
        ...item(staff && on('documents'), {
          to: '/richieste',
          label: 'Richieste',
          icon: <Inbox aria-hidden />,
        }),
        ...item(staff && on('assistance'), {
          to: '/assistenza',
          label: 'Assistenza',
          icon: <LifeBuoy aria-hidden />,
        }),
      ],
    },
    {
      // The functions of the sector turned on from the console.
      label: 'Settore',
      items: (me.current.sectorFeatures ?? []).map((f) => ({
        to: `/settore/${f.id}`,
        label: f.label,
        icon: <Layers aria-hidden />,
      })),
    },
    {
      label: 'Strumenti',
      items: [
        ...item(on('exports'), { to: '/export', label: 'Export', icon: <Download aria-hidden /> }),
        ...item(on('delegations'), {
          to: '/deleghe',
          label: 'Deleghe',
          icon: <Handshake aria-hidden />,
        }),
        ...item(isNetwork && staff && on('network_stats'), {
          to: '/rete/statistiche',
          label: 'Statistiche',
          icon: <ChartColumn aria-hidden />,
        }),
      ],
    },
    {
      label: 'Amministrazione',
      items: [
        ...item(admin, { to: '/persone', label: 'Persone', icon: <Users aria-hidden /> }),
        ...item(admin && isNetwork, {
          to: '/rete',
          label: 'Aderenti',
          icon: <Network aria-hidden />,
          end: true,
        }),
        ...item(admin, { to: '/adesioni', label: 'Adesioni', icon: <Building2 aria-hidden /> }),
        ...item(admin, { to: '/attivita', label: 'Attività', icon: <History aria-hidden /> }),
        ...item(admin, {
          to: '/impostazioni',
          label: 'Impostazioni',
          icon: <Settings aria-hidden />,
        }),
      ],
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/**
 * The dashboard of an organization in the layout of the dashboard-01 block of shadcn/ui: the
 * organization (switchable), «Nuova pratica», the sections, the console for platform
 * administrators and the account at the foot of the sidebar.
 */
export function Layout({ me }: { me: Me }) {
  const { enter, enterPlatform, logout } = useSession();
  const [error, setError] = useState<string | null>(null);
  const current = me.organizations.find((o) => o.orgId === me.current.orgId);
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
    <AppFrame
      sidebarLabel="Menu della dashboard"
      navLabel="Sezioni"
      brand={{ to: '/', icon: <AudioLines aria-hidden className="size-5!" />, name: 'SinfonIA' }}
      context={
        me.organizations.length > 1 ? (
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
        )
      }
      action={{ to: '/pratiche/nuova', label: 'Nuova pratica', icon: <CirclePlus aria-hidden /> }}
      groups={sections(me)}
      switcher={
        me.platform && (
          <SidebarMenuButton
            onClick={() =>
              void enterPlatform().catch((err: unknown) => setError(describeError(err)))
            }
          >
            <ShieldCheck aria-hidden />
            <span>Console</span>
          </SidebarMenuButton>
        )
      }
      account={{
        email: me.email,
        detail: `${role} · ${current?.name ?? ''}`,
        menu: (
          <>
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
          </>
        ),
      }}
      badge={{ label: role }}
      titles={{ '/profilo': 'Profilo' }}
      error={error}
    />
  );
}
