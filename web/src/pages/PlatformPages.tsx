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
  FEATURE_LABELS,
  FEATURES,
  LINK_STATUS_LABELS,
  MODULE_LABELS,
  MODULES,
  moduleLabel,
  organizationsQuery,
  STATUS_LABELS,
  TYPE_LABELS,
  TYPES,
  type OrganizationDetail,
  type OrganizationLinks,
  type OrganizationPage,
  type OrganizationStatus,
  type OrganizationType,
  type Feature,
  type ModuleId,
  type PlatformAuditPage,
  type Verification,
} from '../api/platform';
import { formatDate } from '../api/practices';
import { useSession } from '../session/session';

import { AiUsagePage, HealthPage } from './PlatformHealthPages';

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
        <Route path="piattaforma/salute" element={<HealthPage />} />
        <Route path="piattaforma/consumi-ia" element={<AiUsagePage />} />
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
          <NavLink to="/piattaforma/salute">Salute</NavLink>
          <NavLink to="/piattaforma/consumi-ia">Consumi IA</NavLink>
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
  const [module, setModule] = useState<ModuleId>('generic');
  const [email, setEmail] = useState('');

  const create = useMutation({
    mutationFn: (verification: Verification) =>
      api<{ orgId: string; devToken?: string }>('/platform/organizations', {
        method: 'POST',
        body: { name: name.trim(), type, module, firstAdminEmail: email.trim(), verification },
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
        <label htmlFor="org-module">Settore</label>
        <select
          id="org-module"
          value={module}
          onChange={(e) => setModule(e.target.value as ModuleId)}
        >
          {MODULES.map((m) => (
            <option key={m} value={m}>
              {MODULE_LABELS[m]}
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
            <dt>Settore</dt>
            <dd>{moduleLabel(org.module)}</dd>
          </dl>

          <ModulesCard key={`${org.module}:${(org.disabledFeatures ?? []).join(',')}`} org={org} />

          {org.identifiers && (
            <IdentifiersCard
              key={JSON.stringify(org.identifiers)}
              orgId={org.id}
              identifiers={org.identifiers}
            />
          )}

          <NetworkLinksCard org={org} />

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

/** A03 (voce 16): the sector module and the functions on for one organization. */
function ModulesCard({ org }: { org: OrganizationDetail }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [module, setModule] = useState<ModuleId>(
    (MODULES as readonly string[]).includes(org.module) ? (org.module as ModuleId) : 'generic',
  );
  const [off, setOff] = useState<Feature[]>(
    FEATURES.filter((f) => (org.disabledFeatures ?? []).includes(f)),
  );
  const save = useMutation({
    mutationFn: () =>
      api(`/platform/organizations/${org.id}/modules`, {
        method: 'PATCH',
        body: { module, disabledFeatures: off },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
  });
  const toggle = (feature: Feature, on: boolean) =>
    setOff((current) => (on ? current.filter((f) => f !== feature) : [...current, feature]));

  return (
    <section className="card form" aria-labelledby="modules-title">
      <h2 id="modules-title">Settore e funzioni</h2>
      <p className="muted">
        Valgono dalla prossima richiesta dei membri, su dashboard, API e chat. Spegnere una funzione
        non cancella i dati: tornano visibili quando la si riaccende.
      </p>
      <label htmlFor="modules-module">Settore</label>
      <select
        id="modules-module"
        value={module}
        onChange={(e) => setModule(e.target.value as ModuleId)}
      >
        {MODULES.map((m) => (
          <option key={m} value={m}>
            {MODULE_LABELS[m]}
          </option>
        ))}
      </select>
      <fieldset>
        <legend>Funzioni attive</legend>
        {FEATURES.map((f) => (
          <label key={f} className="checkbox">
            <input
              type="checkbox"
              checked={!off.includes(f)}
              onChange={(e) => toggle(f, e.target.checked)}
            />{' '}
            {FEATURE_LABELS[f]}
          </label>
        ))}
      </fieldset>
      <span className="actions">
        <button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          Salva settore e funzioni
        </button>
      </span>
      {save.isSuccess && (
        <p className="notice" role="status">
          Salvato.
        </p>
      )}
      {save.isError && (
        <p className="error" role="alert">
          {describeError(save.error)}
        </p>
      )}
    </section>
  );
}

// --- AGX-02: identifiers of a company -----------------------------------------------------------

type Identifiers = NonNullable<OrganizationDetail['identifiers']>;

/** «sistema = riferimento», one per line. */
const refsToText = (refs: Record<string, string>) =>
  Object.entries(refs)
    .map(([system, ref]) => `${system} = ${ref}`)
    .join('\n');

function textToRefs(text: string): Record<string, string> | string {
  const refs: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const at = line.indexOf('=');
    if (at < 1) return `Riga «${line.trim()}»: scrivi sistema = riferimento`;
    refs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return refs;
}

function IdentifiersCard({ orgId, identifiers }: { orgId: string; identifiers: Identifiers }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [taxCode, setTaxCode] = useState(identifiers.taxCode ?? '');
  const [vatNumber, setVatNumber] = useState(identifiers.vatNumber ?? '');
  const [refsText, setRefsText] = useState(refsToText(identifiers.externalRefs));
  const refs = textToRefs(refsText);
  const save = useMutation({
    mutationFn: () =>
      api(`/platform/organizations/${orgId}/identifiers`, {
        method: 'PATCH',
        body: {
          taxCode: taxCode.trim() || null,
          vatNumber: vatNumber.trim() || null,
          externalRefs: typeof refs === 'string' ? {} : refs,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
  });

  return (
    <section className="card form" aria-labelledby="identifiers-title">
      <h2 id="identifiers-title">Dati identificativi</h2>
      <p className="muted">
        Li vede e li cambia anche l&apos;amministratore dell&apos;organizzazione, tranne i
        riferimenti esterni. Le reti non li vedono.
      </p>
      <label htmlFor="identifiers-tax-code">Codice fiscale / CUAA</label>
      <input
        id="identifiers-tax-code"
        maxLength={40}
        autoComplete="off"
        value={taxCode}
        onChange={(e) => {
          setTaxCode(e.target.value);
          save.reset();
        }}
      />
      <label htmlFor="identifiers-vat-number">Partita IVA</label>
      <input
        id="identifiers-vat-number"
        maxLength={40}
        inputMode="numeric"
        autoComplete="off"
        value={vatNumber}
        onChange={(e) => {
          setVatNumber(e.target.value);
          save.reset();
        }}
      />
      <label htmlFor="identifiers-refs">Riferimenti in altri sistemi</label>
      <textarea
        id="identifiers-refs"
        rows={3}
        value={refsText}
        placeholder="odoo = res.partner/42"
        onChange={(e) => {
          setRefsText(e.target.value);
          save.reset();
        }}
      />
      <p className="muted">Uno per riga, nella forma «sistema = riferimento».</p>
      {typeof refs === 'string' && (
        <p className="error" role="alert">
          {refs}
        </p>
      )}
      <span className="actions">
        <button
          type="button"
          disabled={save.isPending || typeof refs === 'string'}
          onClick={() => save.mutate()}
        >
          Salva dati identificativi
        </button>
      </span>
      {save.isSuccess && (
        <p className="notice" role="status">
          Salvato.
        </p>
      )}
      {save.isError && (
        <p className="error" role="alert">
          {describeError(save.error)}
        </p>
      )}
    </section>
  );
}

// --- Voce 17: network and companies -------------------------------------------------------------

function NetworkLinksCard({ org }: { org: OrganizationDetail }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState('');

  const links = useQuery({
    queryKey: ['platform', 'organization', org.id, 'links'],
    queryFn: () => api<OrganizationLinks>(`/platform/organizations/${org.id}/links`),
  });
  const isNetwork = links.data?.isNetwork ?? false;
  const candidates = useQuery({
    queryKey: ['platform', 'organizations', 'candidates', search],
    queryFn: () =>
      api<OrganizationPage>(organizationsQuery({ page: 1, search, type: '', status: 'ACTIVE' })),
    enabled: isNetwork,
    placeholderData: keepPreviousData,
  });
  const invite = useMutation({
    mutationFn: () =>
      api(`/platform/organizations/${org.id}/network-members`, {
        method: 'POST',
        body: { orgId: chosen },
      }),
    onSuccess: async () => {
      setChosen('');
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
  });

  if (!links.data) return null;
  const linked = new Set(links.data.members.map((m) => m.orgId));
  const options = (candidates.data?.items ?? []).filter(
    (o) => o.id !== org.id && !linked.has(o.id),
  );
  const list = isNetwork ? links.data.members : links.data.networks;

  return (
    <section className="card form" aria-labelledby="links-title">
      <h2 id="links-title">{isNetwork ? 'Aziende aderenti' : 'Reti'}</h2>
      <p className="muted">
        {isNetwork
          ? "L'adesione parte quando un amministratore dell'azienda la conferma e non dà alla rete accesso ai dati dell'azienda."
          : "Le reti a cui l'organizzazione aderisce o che l'hanno invitata."}
      </p>
      {list.length === 0 ? (
        <p className="muted">{isNetwork ? 'Nessuna azienda.' : 'Nessuna rete.'}</p>
      ) : (
        <ul>
          {list.map((l) => (
            <li key={l.relationId}>
              <Link to={`/piattaforma/organizzazioni/${l.orgId}`}>{l.name}</Link>:{' '}
              {LINK_STATUS_LABELS[l.status]} dal {formatDate(l.since)}
            </li>
          ))}
        </ul>
      )}
      {isNetwork && (
        <>
          <label htmlFor="links-search">Cerca un&apos;azienda da invitare</label>
          <input
            id="links-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={120}
          />
          <label htmlFor="links-org">Azienda</label>
          <select id="links-org" value={chosen} onChange={(e) => setChosen(e.target.value)}>
            <option value="">Scegli…</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <span className="actions">
            <button
              type="button"
              disabled={!chosen || invite.isPending}
              onClick={() => invite.mutate()}
            >
              Invita nella rete
            </button>
          </span>
          {invite.isSuccess && (
            <p className="notice" role="status">
              Invito inviato: l&apos;azienda lo vede in «Adesioni» e deve confermarlo.
            </p>
          )}
          {invite.isError && (
            <p className="error" role="alert">
              {describeError(invite.error)}
            </p>
          )}
        </>
      )}
    </section>
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
