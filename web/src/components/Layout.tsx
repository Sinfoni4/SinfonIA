import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';

import { describeError, ROLE_LABELS, type Me } from '../api/client';
import { useSession } from '../session/session';

/** Header with the current organization (switchable), the profile and the exit. */
export function Layout({ me }: { me: Me }) {
  const { enter, logout } = useSession();
  const [error, setError] = useState<string | null>(null);
  const current = me.organizations.find((o) => o.orgId === me.current.orgId);

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
        </nav>
        <nav aria-label="Account">
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
