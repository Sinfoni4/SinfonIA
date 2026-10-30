import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  ApiError,
  request,
  send,
  type Me,
  type Organization,
  type RequestOptions,
} from '../api/client';

/**
 * The login session in the browser (docs/PROGETTO_FRONTEND_V1.md §6):
 * - the access token (10 minutes) lives only in memory and is renewed before it expires;
 * - the refresh token is an HttpOnly cookie the page cannot read;
 * - the only thing remembered is the id of the last organization, to resume after a reload;
 * - a 401 from the API is retried once after a renewal, then the person is back at the login;
 * - leaving or switching organization empties every cached answer.
 */

export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous'; notice?: string }
  | { status: 'choosing'; organizations: Organization[] }
  | { status: 'ready'; me: Me };

type TokenGrant = { accessToken: string; expiresIn: number };

type Session = {
  state: SessionState;
  startLogin: (email: string) => Promise<{ challengeId: string; devCode?: string }>;
  verifyLogin: (challengeId: string, code: string) => Promise<void>;
  enter: (orgId: string) => Promise<void>;
  logout: () => Promise<void>;
  logoutEverywhere: () => Promise<void>;
  /** A call to the API as the logged-in person, renewing the access token when needed. */
  api: <T>(path: string, options?: Omit<RequestOptions, 'token'>) => Promise<T>;
  /** A file of the API (attachment download) as the logged-in person. */
  download: (path: string) => Promise<{ blob: Blob; fileName: string }>;
};

const SessionContext = createContext<Session | null>(null);

const LAST_ORG = 'sinfonia.lastOrganization';

// Storage can be missing or blocked (private windows): the session works without it.
function rememberOrg(orgId: string | null) {
  try {
    if (orgId) localStorage.setItem(LAST_ORG, orgId);
    else localStorage.removeItem(LAST_ORG);
  } catch {
    /* not available */
  }
}

function lastOrg(): string | null {
  try {
    return localStorage.getItem(LAST_ORG);
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const token = useRef<string | null>(null);
  const orgId = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One renewal at a time: two in parallel would present the same refresh token twice, which the
  // backend treats as a stolen token and answers by revoking the whole session.
  const renewing = useRef<Promise<string> | null>(null);
  const started = useRef(false);

  const forget = useCallback(
    (notice?: string) => {
      if (timer.current) clearTimeout(timer.current);
      token.current = null;
      orgId.current = null;
      rememberOrg(null);
      queryClient.clear();
      setState(notice ? { status: 'anonymous', notice } : { status: 'anonymous' });
    },
    [queryClient],
  );

  /** A new access token for an organization, with the refresh cookie; schedules the next one. */
  const renew = useCallback(
    (org: string): Promise<string> => {
      if (renewing.current) return renewing.current;
      const run = (async () => {
        const grant = await request<TokenGrant>('/auth/token', {
          method: 'POST',
          body: { orgId: org },
        });
        token.current = grant.accessToken;
        orgId.current = org;
        if (timer.current) clearTimeout(timer.current);
        const delay = Math.max(30, grant.expiresIn - 60) * 1000;
        timer.current = setTimeout(() => {
          renew(org).catch(() => forget('La sessione è scaduta: accedi di nuovo.'));
        }, delay);
        return grant.accessToken;
      })();
      renewing.current = run;
      return run.finally(() => {
        renewing.current = null;
      });
    },
    [forget],
  );

  /** Runs a call with the access token; after a 401, renews once and retries, else logs out. */
  const withRenewal = useCallback(
    async <R,>(call: (accessToken: string | undefined) => Promise<R>): Promise<R> => {
      try {
        return await call(token.current ?? undefined);
      } catch (err: unknown) {
        if (!(err instanceof ApiError) || err.status !== 401 || !orgId.current) throw err;
        try {
          return await call(await renew(orgId.current));
        } catch (retryErr: unknown) {
          if (retryErr instanceof ApiError && retryErr.status === 401) {
            forget('La sessione è terminata: accedi di nuovo.');
          }
          throw retryErr;
        }
      }
    },
    [renew, forget],
  );

  const api = useCallback(
    <T,>(path: string, options: Omit<RequestOptions, 'token'> = {}) =>
      withRenewal((accessToken) => request<T>(path, { ...options, token: accessToken })),
    [withRenewal],
  );

  const download = useCallback(
    (path: string) =>
      withRenewal(async (accessToken) => {
        const response = await send(path, { token: accessToken });
        const disposition = response.headers.get('content-disposition') ?? '';
        const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'allegato';
        return { blob: await response.blob(), fileName };
      }),
    [withRenewal],
  );

  const enter = useCallback(
    async (org: string) => {
      queryClient.clear();
      await renew(org);
      rememberOrg(org);
      const me = await request<Me>('/auth/me', { token: token.current ?? undefined });
      setState({ status: 'ready', me });
    },
    [queryClient, renew],
  );

  // After a reload: resume the last organization if the refresh cookie is still valid.
  useEffect(() => {
    // Once per page, also under React's development double effects.
    if (started.current) return;
    started.current = true;
    const org = lastOrg();
    if (!org) {
      setState({ status: 'anonymous' });
      return;
    }
    enter(org).catch(() => forget());
  }, [enter, forget]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const startLogin = useCallback(
    (email: string) =>
      request<{ challengeId: string; devCode?: string }>('/auth/login/start', {
        method: 'POST',
        body: { email },
      }),
    [],
  );

  const verifyLogin = useCallback(
    async (challengeId: string, code: string) => {
      const session = await request<{ organizations: Organization[] }>('/auth/login/verify', {
        method: 'POST',
        body: { challengeId, code },
      });
      if (session.organizations.length === 0) {
        setState({
          status: 'anonymous',
          notice: 'Il tuo account non è attivo in nessuna azienda: contatta un amministratore.',
        });
      } else if (session.organizations.length === 1) {
        await enter(session.organizations[0].orgId);
      } else {
        setState({ status: 'choosing', organizations: session.organizations });
      }
    },
    [enter],
  );

  const logout = useCallback(async () => {
    await request('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    forget();
  }, [forget]);

  const logoutEverywhere = useCallback(async () => {
    await api('/auth/logout-all', { method: 'POST', body: {} });
    forget('Sei uscito da tutti i dispositivi.');
  }, [api, forget]);

  const value = useMemo<Session>(
    () => ({ state, startLogin, verifyLogin, enter, logout, logoutEverywhere, api, download }),
    [state, startLogin, verifyLogin, enter, logout, logoutEverywhere, api, download],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}
