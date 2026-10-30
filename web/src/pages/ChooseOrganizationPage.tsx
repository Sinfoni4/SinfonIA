import { useState } from 'react';

import { describeError, ROLE_LABELS, type Organization } from '../api/client';
import { useSession } from '../session/session';

/** P2: a person in several organizations chooses where to work. */
export function ChooseOrganizationPage({ organizations }: { organizations: Organization[] }) {
  const { enter, logout } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = async (orgId: string) => {
    setBusy(true);
    setError(null);
    try {
      await enter(orgId);
    } catch (err: unknown) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <section className="card auth-card" aria-labelledby="choose-title">
        <h1 id="choose-title">Con quale azienda vuoi lavorare?</h1>
        <ul className="choices">
          {organizations.map((o) => (
            <li key={o.orgId}>
              <button type="button" disabled={busy} onClick={() => void choose(o.orgId)}>
                <span>{o.name}</span>
                <span className="muted">{ROLE_LABELS[o.role]}</span>
              </button>
            </li>
          ))}
        </ul>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="link" onClick={() => void logout()}>
          Esci
        </button>
      </section>
    </main>
  );
}
