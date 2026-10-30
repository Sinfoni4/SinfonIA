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
  /** JSON body. */
  body?: unknown;
  /** Multipart body (file uploads); the browser sets its content type. */
  form?: FormData;
  token?: string;
};

/** The raw response of a call (for downloads); errors still become ApiError. */
export async function send(path: string, options: RequestOptions = {}): Promise<Response> {
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
      body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Servizio non raggiungibile');
  }
  if (!response.ok) {
    const envelope = (await response.json().catch(() => null)) as Envelope<unknown> | null;
    const error = envelope && !envelope.success ? envelope.error : undefined;
    throw new ApiError(
      response.status,
      error?.code ?? 'HTTP_ERROR',
      error?.message ?? response.statusText,
    );
  }
  return response;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);
  if (response.status === 204) return undefined as T;
  const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (!envelope || !envelope.success) {
    throw new ApiError(response.status, 'BAD_RESPONSE', 'Risposta non valida');
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
  if (err.status === 404) return 'Non trovato, oppure non è nel tuo perimetro.';
  if (err.code === 'ATTACHMENT_TOO_LARGE') return 'Il file è troppo grande.';
  if (err.code === 'UNSUPPORTED_MEDIA_TYPE')
    return 'Tipo di file non supportato: usa PDF o immagini.';
  if (err.code === 'EMPTY_ATTACHMENT') return 'Il file è vuoto.';
  if (err.status === 409) return 'Operazione non consentita nello stato attuale.';
  return 'Si è verificato un errore: riprova.';
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'amministratore',
  OPERATOR: 'operatore',
  MEMBER: 'collaboratore',
};
