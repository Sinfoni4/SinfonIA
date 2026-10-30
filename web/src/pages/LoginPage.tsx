import { useState, type FormEvent } from 'react';

import { describeError } from '../api/client';
import { useSession } from '../session/session';

/** P1: access with a one-time code sent by email (§4.1 of the identity plan). */
export function LoginPage({ notice }: { notice?: string }) {
  const { startLogin, verifyLogin } = useSession();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [devCode, setDevCode] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sendCode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const started = await startLogin(email.trim());
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

  const checkCode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await verifyLogin(challengeId, code.trim());
    } catch (err: unknown) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <section className="card auth-card" aria-labelledby="login-title">
        <h1 id="login-title" className="brand">
          SinfonIA
        </h1>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {step === 'email' ? (
          <form onSubmit={(e) => void sendCode(e)} noValidate>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" disabled={busy || !email.includes('@')}>
              Ricevi il codice di accesso
            </button>
          </form>
        ) : (
          <form onSubmit={(e) => void checkCode(e)} noValidate>
            <p className="muted">
              Se l&apos;indirizzo <strong>{email}</strong> è registrato, ti abbiamo inviato un
              codice di 6 cifre. Vale 10 minuti.
            </p>
            {devCode && (
              <p className="dev-code" role="note">
                Ambiente di sviluppo: il codice è <strong>{devCode}</strong>
              </p>
            )}
            <label htmlFor="code">Codice</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <button type="submit" disabled={busy || code.length !== 6}>
              Accedi
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setStep('email');
                setError(null);
              }}
            >
              Usa un&apos;altra email
            </button>
          </form>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
