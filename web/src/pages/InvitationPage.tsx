import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { describeError } from '../api/client';
import { tokenFromHash } from '../api/members';
import { useSession } from '../session/session';

/**
 * P9: acceptance of an invitation (§4.2 of the identity plan). The link in the email carries the
 * invitation code after `#`; the page reads it, removes it from the address bar and history, then
 * sends a 6-digit confirmation code to the invited email.
 */
export function InvitationPage() {
  const { startInvitation, acceptInvitation } = useSession();
  const navigate = useNavigate();
  const [inviteToken, setInviteToken] = useState(() => tokenFromHash(window.location.hash));
  // Arrived from the email link: no field to fill, only the confirmation.
  const [fromLink] = useState(() => inviteToken !== '');
  const [step, setStep] = useState<'token' | 'code'>('token');
  const [challengeId, setChallengeId] = useState('');
  const [devCode, setDevCode] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }, []);

  const sendCode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const started = await startInvitation(inviteToken.trim());
      setChallengeId(started.challengeId);
      setDevCode(started.devCode);
      setCode('');
      setStep('code');
    } catch (err: unknown) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const accept = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await acceptInvitation(inviteToken.trim(), challengeId, code.trim());
      void navigate('/', { replace: true });
    } catch (err: unknown) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <section className="card auth-card" aria-labelledby="invitation-title">
        <h1 id="invitation-title" className="brand">
          SinfonIA
        </h1>
        <h2>Accetta l&apos;invito</h2>
        {step === 'token' ? (
          <form onSubmit={(e) => void sendCode(e)} noValidate>
            {fromLink ? (
              <p className="muted">
                Invito ricevuto. Per confermare che l&apos;email è tua ti inviamo un codice di 6
                cifre.
              </p>
            ) : (
              <>
                <p className="muted">Incolla il codice invito che hai ricevuto per email.</p>
                <label htmlFor="invite-token">Codice invito</label>
                <input
                  id="invite-token"
                  autoComplete="off"
                  spellCheck={false}
                  value={inviteToken}
                  onChange={(e) => setInviteToken(e.target.value)}
                />
              </>
            )}
            <button type="submit" disabled={busy || inviteToken.trim().length < 20}>
              Ricevi il codice di conferma
            </button>
          </form>
        ) : (
          <form onSubmit={(e) => void accept(e)} noValidate>
            <p className="muted">
              Ti abbiamo inviato un codice di 6 cifre all&apos;email dell&apos;invito. Vale 10
              minuti.
            </p>
            {devCode && (
              <p className="dev-code" role="note">
                Ambiente di sviluppo: il codice è <strong>{devCode}</strong>
              </p>
            )}
            <label htmlFor="invite-code">Codice</label>
            <input
              id="invite-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <button type="submit" disabled={busy || code.length !== 6}>
              Accetta ed entra
            </button>
          </form>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p>
          <Link to="/">Torna all&apos;accesso</Link>
        </p>
      </section>
    </main>
  );
}
