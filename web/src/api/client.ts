/**
 * Calls to the SinfonIA API from the dashboard. Same origin (B2): the refresh cookie travels by
 * itself to /auth, the access token is passed in memory, never stored. Every request is marked as
 * coming from the dashboard (B8), a label for the audit only.
 */

export type Role = 'ADMIN' | 'OPERATOR' | 'MEMBER';

export type Organization = { orgId: string; name: string; role: Role };

export type Me = {
  userId: string;
  email: string | null;
  organizations: Organization[];
  current: { orgId: string; role: Role };
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Envelope<T> =
  { success: true; data: T } | { success: false; error: { code: string; message: string } };

export type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string;
};

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        'x-sinfonia-client': 'web',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Servizio non raggiungibile');
  }
  if (response.status === 204) return undefined as T;
  const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (!response.ok || !envelope || !envelope.success) {
    const error = envelope && !envelope.success ? envelope.error : undefined;
    throw new ApiError(
      response.status,
      error?.code ?? 'HTTP_ERROR',
      error?.message ?? response.statusText,
    );
  }
  return envelope.data;
}

/** A message the person can act on, in Italian, for an error of the API. */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Si è verificato un errore imprevisto.';
  if (err.status === 0) return 'Servizio non raggiungibile: controlla la connessione e riprova.';
  if (err.status === 401) return 'Codice non valido o scaduto.';
  if (err.status === 403) return 'Non hai il permesso per questa operazione.';
  if (err.status === 429) return 'Troppi tentativi: riprova tra qualche minuto.';
  return 'Si è verificato un errore: riprova.';
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'amministratore',
  OPERATOR: 'operatore',
  MEMBER: 'collaboratore',
};
