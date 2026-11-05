import { LogOut, Menu, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';

import { describeError, ROLE_LABELS, type Me } from '../api/client';
import { NETWORK_TYPES } from '../api/organization';
import { useSession } from '../session/session';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';

/** A section of the header: the current page stands out (FE5, shadcn/ui). */
function Section({ to, children }: { to: string; children: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/rete'}
      className={({ isActive }) =>
        cn(
          'rounded-md px-3 py-1.5 text-sm font-medium no-underline transition-colors hover:bg-accent',
          isActive ? 'bg-secondary text-primary' : 'text-foreground',
        )
      }
    >
      {children}
    </NavLink>
  );
}

/** Header with the current organization (switchable), the sections, the profile and the exit. */
export function Layout({ me }: { me: Me }) {
  const { enter, enterPlatform, logout } = useSession();
  const [error, setError] = useState<string | null>(null);
  // FE5: on a phone the sections fold behind «Menu»; a new page closes it.
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  // FE5: after a change of page, keyboard and screen readers start from the new content.
  const main = useRef<HTMLElement>(null);
  const firstPage = useRef(true);
  useEffect(() => {
    setMenuOpen(false);
    if (firstPage.current) {
      firstPage.current = false;
      return;
    }
    main.current?.focus();
  }, [pathname]);
  const current = me.organizations.find((o) => o.orgId === me.current.orgId);
  // MF9: the sections of a network (G5); the backend refuses them to other types anyway.
  const isNetwork = current?.type !== undefined && NETWORK_TYPES.includes(current.type);
  const staff = me.current.role !== 'MEMBER';
  const admin = me.current.role === 'ADMIN';

  const switchTo = async (orgId: string) => {
    setError(null);
    try {
      await enter(orgId);
    } catch (err: unknown) {
      setError(describeError(err));
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <a href="#contenuto" className="skip-link">
        Vai al contenuto
      </a>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <NavLink to="/" className="text-xl font-bold text-primary no-underline">
            SinfonIA
          </NavLink>
          <div className="order-3 flex min-w-0 basis-full items-center gap-2 md:order-none md:basis-auto md:flex-1">
            {me.organizations.length > 1 ? (
              <NativeSelect
                className="w-auto max-w-64"
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
            <Badge>{ROLE_LABELS[me.current.role]}</Badge>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto md:hidden"
            aria-expanded={menuOpen}
            aria-controls="main-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X aria-hidden /> : <Menu aria-hidden />}
            {menuOpen ? 'Chiudi' : 'Menu'}
          </Button>
          <div
            id="main-menu"
            className={cn(
              'order-4 w-full flex-col gap-2 md:order-none md:flex md:flex-row md:flex-wrap md:items-center md:justify-between',
              menuOpen ? 'flex' : 'hidden',
            )}
          >
            <nav
              aria-label="Sezioni"
              className="flex min-w-0 flex-col gap-1 md:flex-1 md:flex-row md:flex-wrap"
            >
              <Section to="/pratiche">Pratiche</Section>
              {staff && <Section to="/bacheca">Bacheca</Section>}
              <Section to="/scadenze">Scadenze</Section>
              <Section to="/verifica">Da verificare</Section>
              {staff && <Section to="/assistenza">Assistenza</Section>}
              <Section to="/export">Export</Section>
              <Section to="/deleghe">Deleghe</Section>
              {isNetwork && staff && <Section to="/rete/statistiche">Statistiche</Section>}
              {admin && (
                <>
                  <Section to="/persone">Persone</Section>
                  {isNetwork && <Section to="/rete">Aderenti</Section>}
                  <Section to="/adesioni">Adesioni</Section>
                  <Section to="/attivita">Attività</Section>
                  <Section to="/impostazioni">Impostazioni</Section>
                </>
              )}
            </nav>
            <nav
              aria-label="Account"
              className="flex flex-col gap-1 border-t border-border pt-2 md:flex-row md:items-center md:border-0 md:pt-0"
            >
              {me.platform && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-start"
                  onClick={() =>
                    void enterPlatform().catch((err: unknown) => setError(describeError(err)))
                  }
                >
                  Console
                </Button>
              )}
              <Section to="/profilo">Profilo</Section>
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => void logout()}
              >
                <LogOut aria-hidden />
                Esci
              </Button>
            </nav>
          </div>
        </div>
      </header>
      {error && (
        <p className="error banner" role="alert">
          {error}
        </p>
      )}
      <main className="content" id="contenuto" tabIndex={-1} ref={main}>
        <Outlet />
      </main>
    </div>
  );
}
