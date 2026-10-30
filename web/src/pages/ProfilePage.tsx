import { useState } from 'react';

import { describeError, ROLE_LABELS, type Me } from '../api/client';
import { useSession } from '../session/session';

/** P10: who is logged in, where they can work, and the two ways out. */
export function ProfilePage({ me }: { me: Me }) {
  const { logout, logoutEverywhere } = useSession();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const everywhere = async () => {
    setError(null);
    try {
      await logoutEverywhere();
    } catch (err: unknown) {
      setError(describeError(err));
    }
  };

  return (
    <>
      <h1>Profilo</h1>
      <section className="card">
        <dl className="facts">
          <dt>Email</dt>
          <dd>{me.email ?? 'non impostata (account creato dalla chat)'}</dd>
          <dt>Aziende</dt>
          <dd>
            <ul className="plain">
              {me.organizations.map((o) => (
                <li key={o.orgId}>
                  {o.name} — {ROLE_LABELS[o.role]}
                  {o.orgId === me.current.orgId && <span className="badge">attuale</span>}
                </li>
              ))}
            </ul>
          </dd>
        </dl>
      </section>
      <section className="card">
        <h2>Uscita</h2>
        <div className="actions">
          <button type="button" onClick={() => void logout()}>
            Esci da questo dispositivo
          </button>
          {confirming ? (
            <>
              <span>Chiudere la sessione su tutti i dispositivi, compreso questo?</span>
              <button type="button" className="danger" onClick={() => void everywhere()}>
                Sì, esci ovunque
              </button>
              <button type="button" className="link" onClick={() => setConfirming(false)}>
                Annulla
              </button>
            </>
          ) : (
            <button type="button" className="secondary" onClick={() => setConfirming(true)}>
              Esci da tutti i dispositivi
            </button>
          )}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </>
  );
}
