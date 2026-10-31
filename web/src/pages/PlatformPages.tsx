import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router';

import { describeError, type PlatformAdmin } from '../api/client';
import { invitationLink } from '../api/members';
import { formatDateTime } from '../api/organization';
import {
  describePlatformAction,
  organizationsQuery,
  STATUS_LABELS,
  TYPE_LABELS,
  TYPES,
  type OrganizationDetail,
  type OrganizationPage,
  type OrganizationStatus,
  type OrganizationType,
  type PlatformAuditPage,
  type Verification,
} from '../api/platform';
import { formatDate } from '../api/practices';
import { useSession } from '../session/session';

/**
 * FE7: the platform console (docs/PROGETTO_FRONTEND_V2.md §5): organizations, new organization,
 * suspension, platform audit log. It manages organizations and never shows their data (G3).
 */
export function PlatformApp({ admin }: { admin: PlatformAdmin }) {
  return (
    <Routes>
      <Route element={<PlatformLayout admin={admin} />}>
        <Route path="piattaforma" element={<OrganizationsPage />} />
        <Route path="piattaforma/nuova" element={<NewOrganizationPage />} />
        <Route path="piattaforma/organizzazioni/:id" element={<OrganizationPage />} />
        <Route path="piattaforma/registro" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/piattaforma" replace />} />
      </Route>
    </Routes>
  );
}

function PlatformLayout({ admin }: { admin: PlatformAdmin }) {
  const { leavePlatform, logout } = useSession();
  const [error, setError] = useState<string | null>(null);

  const back = async () => {
    setError(null);
    try {
      await leavePlatform();
    } catch (err: unknown) {
      setError(describeError(err));
    }
  };

  return (
    <div className="shell">
      <header className="topbar console">
        <NavLink to="/piattaforma" className="brand">
          SinfonIA
        </NavLink>
        <div className="org">
          <span>Console di piattaforma</span>
          <span className="badge warn">{admin.email}</span>
        </div>
        <nav aria-label="Sezioni della console">
          <NavLink to="/piattaforma" end>
            Organizzazioni
          </NavLink>
          <NavLink to="/piattaforma/registro">Registro</NavLink>
        </nav>
        <nav aria-label="Account">
          {admin.organizations.length > 0 && (
            <button type="button" className="link" onClick={() => void back()}>
              Le mie aziende
            </button>
          )}
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

/** G2: asks for a code by email and collects it; the action sends it with its own request. */
function useConfirmationCode() {
  const { api } = useSession();
  const [challenge, setChallenge] = useState<{ challengeId: string; devCode?: string } | null>(
    null,
  );
  const [code, setCode] = useState('');
  const request = useMutation({
    mutationFn: () =>
      api<{ challengeId: string; devCode?: string }>('/platform/verification', {
        method: 'POST',
        body: {},
      }),
    onSuccess: (data) => {
      setChallenge(data);
      setCode('');
    },
  });
  const verification: Verification | null =
    challenge && /^\d{6}$/.test(code) ? { challengeId: challenge.challengeId, code } : null;
  const reset = () => {
    setChallenge(null);
    setCode('');
  };
  return { request, challenge, code, setCode, verification, reset };
}

function ConfirmationCode({
  confirm,
  idPrefix,
}: {
  confirm: ReturnType<typeof useConfirmationCode>;
  idPrefix: string;
}) {
  if (!confirm.challenge) {
    return (
      <>
        <button
          type="button"
          className="secondary"
          disabled={confirm.request.isPending}
          onClick={() => confirm.request.mutate()}
        >
          Invia il codice di conferma alla mia email
        </button>
        {confirm.request.isError && (
          <p className="error" role="alert">
            {describeError(confirm.request.error)}
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <p className="muted">Ti abbiamo inviato un codice di 6 cifre. Vale 10 minuti.</p>
      {confirm.challenge.devCode && (
        <p className="dev-code" role="note">
          Ambiente di sviluppo: il codice è <strong>{confirm.challenge.devCode}</strong>
        </p>
      )}
      <label htmlFor={`${idPrefix}-code`}>Codice di conferma</label>
      <input
        id={`${idPrefix}-code`}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={confirm.code}
        onChange={(e) => confirm.setCode(e.target.value.replace(/\D/g, ''))}
      />
    </>
  );
}

// --- A1 -----------------------------------------------------------------------------------------

function OrganizationsPage() {
  const { api } = useSession();
  const [filters, setFilters] = useState<{
    page: number;
    search: string;
    type: OrganizationType | '';
    status: OrganizationStatus | '';
  }>({ page: 1, search: '', type: '', status: '' });
  const query = useQuery({
    queryKey: ['platform', 'organizations', filters],
    queryFn: () => api<OrganizationPage>(organizationsQuery(filters)),
    placeholderData: keepPreviousData,
  });
  const data = query.data;

  return (
    <>
      <div className="page-head">
        <h1>Organizzazioni</h1>
        <Link className="button" to="/piattaforma/nuova">
          Nuova organizzazione
        </Link>
      </div>
      <div className="filters">
        <label>
          Cerca
          <input
            type="search"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, page: 1, search: e.target.value }))}
          />
        </label>
        <label>
          Tipo
          <select
            value={filters.type}
            onChange={(e) =>
              setFilters((f) => ({ ...f, page: 1, type: e.target.value as OrganizationType | '' }))
            }
          >
            <option value="">Tutti</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Stato
          <select
            value={filters.status}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                page: 1,
                status: e.target.value as OrganizationStatus | '',
              }))
            }
          >
            <option value="">Tutti</option>
            {(Object.keys(STATUS_LABELS) as OrganizationStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {data && data.items.length === 0 && <p className="muted">Nessuna organizzazione.</p>}
      {data && data.items.length > 0 && (
        <>
          <table className="list cards">
            <thead>
              <tr>
                <th scope="col">Organizzazione</th>
                <th scope="col">Stato</th>
                <th scope="col">Membri</th>
                <th scope="col">Pratiche</th>
                <th scope="col">Ultima attività</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id}>
                  <td data-label="Organizzazione">
                    <Link to={`/piattaforma/organizzazioni/${o.id}`}>{o.name}</Link>
                    <div className="muted">{TYPE_LABELS[o.type]}</div>
                  </td>
                  <td data-label="Stato">
                    <span className={`state ${o.status === 'ACTIVE' ? '' : 'state-failed'}`}>
                      {STATUS_LABELS[o.status]}
                    </span>
                  </td>
                  <td data-label="Membri">{o.members}</td>
                  <td data-label="Pratiche">{o.practices}</td>
                  <td data-label="Ultima attività">
                    {o.lastActivityAt ? formatDate(o.lastActivityAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.totalPages > 1 && (
            <nav className="pager" aria-label="Pagine">
              <button
                type="button"
                className="secondary"
                disabled={data.page <= 1}
                onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
              >
                Precedenti
              </button>
              <span>
                Pagina {data.page} di {data.totalPages} ({data.total})
              </span>
              <button
                type="button"
                className="secondary"
                disabled={data.page >= data.totalPages}
                onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
              >
                Successive
              </button>
            </nav>
          )}
        </>
      )}
      <p className="muted">
        La console mostra numeri, stati e i contatti degli amministratori: mai pratiche, documenti o
        scadenze delle organizzazioni.
      </p>
    </>
  );
}

// --- A2 -----------------------------------------------------------------------------------------

function NewOrganizationPage() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirmationCode();
  const [name, setName] = useState('');
  const [type, setType] = useState<OrganizationType>('COMPANY');
  const [email, setEmail] = useState('');

  const create = useMutation({
    mutationFn: (verification: Verification) =>
      api<{ orgId: string; devToken?: string }>('/platform/organizations', {
        method: 'POST',
        body: { name: name.trim(), type, firstAdminEmail: email.trim(), verification },
      }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
      void navigate(`/piattaforma/organizzazioni/${data.orgId}`, {
        state: { invited: email.trim(), devToken: data.devToken },
      });
    },
    // A used or wrong code cannot be retried: a new one is needed.
    onError: () => confirm.reset(),
  });

  const ready = name.trim().length >= 2 && email.includes('@');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (confirm.verification) create.mutate(confirm.verification);
  };

  return (
    <>
      <h1>Nuova organizzazione</h1>
      <form className="card form" onSubmit={submit} aria-labelledby="new-org-title">
        <h2 id="new-org-title">Dati</h2>
        <label htmlFor="org-name">Nome</label>
        <input
          id="org-name"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor="org-type">Tipo</label>
        <select
          id="org-type"
          value={type}
          onChange={(e) => setType(e.target.value as OrganizationType)}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <label htmlFor="org-admin">Email del primo amministratore</label>
        <input
          id="org-admin"
          type="email"
          autoComplete="off"
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <p className="muted">
          Riceverà un invito per email: la piattaforma non crea account e non entra
          nell&apos;organizzazione.
        </p>
        <h2>Conferma</h2>
        <ConfirmationCode confirm={confirm} idPrefix="new-org" />
        <button type="submit" disabled={!ready || !confirm.verification || create.isPending}>
          Crea e invia l&apos;invito
        </button>
        {create.isError && (
          <p className="error" role="alert">
            {describeError(create.error)}
          </p>
        )}
      </form>
    </>
  );
}

// --- A3 -----------------------------------------------------------------------------------------

function OrganizationPage() {
  const { id = '' } = useParams();
  const { api } = useSession();
  // Just created here: who was invited (and, in development only, the acceptance link).
  const created = useLocation().state as { invited?: string; devToken?: string } | null;
  const queryClient = useQueryClient();
  const confirm = useConfirmationCode();
  const [reason, setReason] = useState('');
  const [changing, setChanging] = useState(false);

  const query = useQuery({
    queryKey: ['platform', 'organization', id],
    queryFn: () => api<OrganizationDetail>(`/platform/organizations/${id}`),
  });

  const change = useMutation({
    mutationFn: (input: { suspend: boolean; verification: Verification }) =>
      api(`/platform/organizations/${id}/${input.suspend ? 'suspend' : 'reactivate'}`, {
        method: 'POST',
        body: input.suspend
          ? { reason: reason.trim(), verification: input.verification }
          : { verification: input.verification },
      }),
    onSuccess: async () => {
      setChanging(false);
      setReason('');
      confirm.reset();
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
    onError: () => confirm.reset(),
  });

  const org = query.data;
  const suspend = org?.status === 'ACTIVE';

  return (
    <>
      <p>
        <Link to="/piattaforma">← Organizzazioni</Link>
      </p>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {org && (
        <>
          <h1>{org.name}</h1>
          {created?.invited && (
            <p className="notice" role="status">
              Organizzazione creata: invito inviato a <strong>{created.invited}</strong>.
            </p>
          )}
          {created?.devToken && (
            <p className="dev-code" role="note">
              Ambiente di sviluppo: link di accettazione da aprire in una finestra anonima{' '}
              <code className="dev-link">
                {invitationLink(window.location.origin, created.devToken)}
              </code>
            </p>
          )}
          <dl className="facts card">
            <dt>Tipo</dt>
            <dd>{TYPE_LABELS[org.type]}</dd>
            <dt>Stato</dt>
            <dd>
              <span className={`state ${org.status === 'ACTIVE' ? '' : 'state-failed'}`}>
                {STATUS_LABELS[org.status]}
              </span>
            </dd>
            <dt>Creata il</dt>
            <dd>{formatDate(org.createdAt)}</dd>
            <dt>Membri attivi</dt>
            <dd>{org.members}</dd>
            <dt>Pratiche</dt>
            <dd>{org.practices}</dd>
            <dt>Ultima attività</dt>
            <dd>{org.lastActivityAt ? formatDateTime(org.lastActivityAt) : '—'}</dd>
            <dt>Inviti in attesa</dt>
            <dd>{org.pendingInvitations}</dd>
            <dt>Export pianificato</dt>
            <dd>{org.scheduledExport ? 'attivo' : 'non attivo'}</dd>
            <dt>Integrazione esterna</dt>
            <dd>{org.webhook ? 'sì' : 'no'}</dd>
          </dl>

          <section className="card" aria-labelledby="admins-title">
            <h2 id="admins-title">Amministratori</h2>
            {org.administrators.length === 0 ? (
              <p className="muted">
                Nessun amministratore attivo
                {org.pendingInvitations > 0 ? ': l’invito è in attesa di essere accettato.' : '.'}
              </p>
            ) : (
              <ul className="plain">
                {org.administrators.map((a, i) => (
                  <li key={`${a.email ?? 'chat'}-${i}`}>
                    {a.email ?? <span className="muted">account della chat, senza email</span>}
                    <div className="muted">dal {formatDate(a.since)}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {(org.status === 'ACTIVE' || org.status === 'SUSPENDED') && (
            <section className="card form" aria-labelledby="status-title">
              <h2 id="status-title">
                {suspend ? 'Sospendi l’organizzazione' : 'Riattiva l’organizzazione'}
              </h2>
              <p className="muted">
                {suspend
                  ? 'I membri perdono subito l’accesso da dashboard, API e chat e le attività pianificate si fermano. I dati restano intatti.'
                  : 'I membri ritrovano l’accesso alla prossima richiesta.'}
              </p>
              {!changing ? (
                <button
                  type="button"
                  className={suspend ? 'danger' : 'secondary'}
                  onClick={() => setChanging(true)}
                >
                  {suspend ? 'Sospendi…' : 'Riattiva…'}
                </button>
              ) : (
                <>
                  {suspend && (
                    <>
                      <label htmlFor="suspend-reason">Motivo</label>
                      <input
                        id="suspend-reason"
                        maxLength={500}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </>
                  )}
                  <ConfirmationCode confirm={confirm} idPrefix="status" />
                  <span className="actions">
                    <button
                      type="button"
                      className={suspend ? 'danger' : undefined}
                      disabled={
                        !confirm.verification ||
                        (suspend && reason.trim().length < 3) ||
                        change.isPending
                      }
                      onClick={() =>
                        confirm.verification &&
                        change.mutate({ suspend, verification: confirm.verification })
                      }
                    >
                      {suspend ? 'Conferma sospensione' : 'Conferma riattivazione'}
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        setChanging(false);
                        confirm.reset();
                      }}
                    >
                      Annulla
                    </button>
                  </span>
                </>
              )}
              {change.isError && (
                <p className="error" role="alert">
                  {describeError(change.error)}
                </p>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}

// --- A6 -----------------------------------------------------------------------------------------

function AuditPage() {
  const { api } = useSession();
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['platform', 'audit', page],
    queryFn: () => api<PlatformAuditPage>(`/platform/audit?page=${page}`),
    placeholderData: keepPreviousData,
  });
  const data = query.data;

  return (
    <>
      <h1>Registro della piattaforma</h1>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {data && data.items.length === 0 && <p className="muted">Nessuna azione registrata.</p>}
      {data && data.items.length > 0 && (
        <table className="list cards">
          <thead>
            <tr>
              <th scope="col">Quando</th>
              <th scope="col">Chi</th>
              <th scope="col">Che cosa</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.id}>
                <td data-label="Quando">{formatDateTime(r.at)}</td>
                <td data-label="Chi">
                  {r.actorEmail ?? (r.details.via === 'script' ? 'script sul server' : '—')}
                </td>
                <td data-label="Che cosa">{describePlatformAction(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.totalPages > 1 && (
        <nav className="pager" aria-label="Pagine">
          <button
            type="button"
            className="secondary"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Precedenti
          </button>
          <span>
            Pagina {data.page} di {data.totalPages}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={page >= data.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Successive
          </button>
        </nav>
      )}
      <p className="muted">
        Ogni azione dei gestori resta qui e non si può modificare. Le azioni su
        un&apos;organizzazione compaiono anche nel suo registro attività.
      </p>
    </>
  );
}
