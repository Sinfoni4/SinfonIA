import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';

import { describeError, ROLE_LABELS, type Me } from '../api/client';
import { NETWORK_TYPES } from '../api/organization';
import { useSession } from '../session/session';

/** Header with the current organization (switchable), the profile and the exit. */
export function Layout({ me }: { me: Me }) {
  const { enter, enterPlatform, logout } = useSession();
  const [error, setError] = useState<string | null>(null);
  const current = me.organizations.find((o) => o.orgId === me.current.orgId);
  // MF9: the sections of a network (G5); the backend refuses them to other types anyway.
  const isNetwork = current?.type !== undefined && NETWORK_TYPES.includes(current.type);

  const switchTo = async (orgId: string) => {
    setError(null);
    try {
      await enter(orgId);
    } catch (err: unknown) {
      setError(describeError(err));
    }
  };

  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="brand">
          SinfonIA
        </NavLink>
        <div className="org">
          {me.organizations.length > 1 ? (
            <label>
              <span className="visually-hidden">Azienda</span>
              <select
                value={me.current.orgId}
                onChange={(e) => void switchTo(e.target.value)}
                aria-label="Azienda"
              >
                {me.organizations.map((o) => (
                  <option key={o.orgId} value={o.orgId}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span>{current?.name}</span>
          )}
          <span className="badge">{ROLE_LABELS[me.current.role]}</span>
        </div>
        <nav aria-label="Sezioni">
          <NavLink to="/pratiche">Pratiche</NavLink>
          {me.current.role !== 'MEMBER' && <NavLink to="/bacheca">Bacheca</NavLink>}
          <NavLink to="/scadenze">Scadenze</NavLink>
          <NavLink to="/verifica">Da verificare</NavLink>
          {me.current.role !== 'MEMBER' && <NavLink to="/assistenza">Assistenza</NavLink>}
          <NavLink to="/export">Export</NavLink>
          <NavLink to="/deleghe">Deleghe</NavLink>
          {isNetwork && me.current.role !== 'MEMBER' && (
            <NavLink to="/rete/statistiche">Statistiche</NavLink>
          )}
          {me.current.role === 'ADMIN' && (
            <>
              <NavLink to="/persone">Persone</NavLink>
              {isNetwork && <NavLink to="/rete">Aderenti</NavLink>}
              <NavLink to="/adesioni">Adesioni</NavLink>
              <NavLink to="/attivita">Attività</NavLink>
              <NavLink to="/impostazioni">Impostazioni</NavLink>
            </>
          )}
        </nav>
        <nav aria-label="Account">
          {me.platform && (
            <button
              type="button"
              className="link"
              onClick={() =>
                void enterPlatform().catch((err: unknown) => setError(describeError(err)))
              }
            >
              Console
            </button>
          )}
          <NavLink to="/profilo">Profilo</NavLink>
          <button type="button" className="link" onClick={() => void logout()}>
            Esci
          </button>
        </nav>
      </header>
      {error && (
        <p className="error banner" role="alert">
          {error}
        </p>
      )}
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
