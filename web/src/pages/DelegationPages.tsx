import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';

import { describeError, type Me } from '../api/client';
import { exportFileName } from '../api/compliance';
import {
  BENEFICIARY_NAMES,
  DURATIONS,
  endDateIn,
  maxMonths,
  OFFERED_OPERATIONS,
  OPERATION_LABELS,
  STATE_NAMES,
  type DelegatedPage,
  type DelegatedPracticeDetail,
  type GrantOperation,
  type IssuedGrant,
  type ReceivedGrant,
} from '../api/delegations';
import { type Member } from '../api/members';
import { fieldValues, shownFields, type CurrentModule } from '../api/modules';
import {
  formatDate,
  kindLabel,
  NEXT_STATES,
  STATE_LABELS,
  TRANSITION_LABELS,
  type Practice,
  type PracticeState,
} from '../api/practices';
import { missingRequired, PracticeFieldInputs } from '../components/PracticeFieldInputs';
import { useSession } from '../session/session';

import { AttachmentItem, UploadForm } from './PracticeDetailPage';

const opsText = (ops: GrantOperation[]) => ops.map((o) => OPERATION_LABELS[o]).join(', ');

/**
 * P19 and P20 (MF8, D3): the delegations the organization gave (administrators) and those it or
 * the person received.
 */
export function DelegationsPage({ me }: { me: Me }) {
  const isAdmin = me.current.role === 'ADMIN';
  const [tab, setTab] = useState<'issued' | 'received'>(isAdmin ? 'issued' : 'received');
  return (
    <>
      <h1>Deleghe</h1>
      <p className="muted">
        Una delega permette a una persona o a un&apos;altra organizzazione di lavorare sulle
        pratiche dell&apos;azienda, solo per le operazioni scelte e fino a una data: al massimo 12
        mesi, 3 se comprende l&apos;export. Si rinnova solo con una scelta esplicita e si revoca in
        qualsiasi momento.
      </p>
      <nav className="tabs" aria-label="Deleghe">
        {isAdmin && (
          <button
            type="button"
            className={`link ${tab === 'issued' ? 'active' : ''}`}
            aria-pressed={tab === 'issued'}
            onClick={() => setTab('issued')}
          >
            Concesse
          </button>
        )}
        <button
          type="button"
          className={`link ${tab === 'received' ? 'active' : ''}`}
          aria-pressed={tab === 'received'}
          onClick={() => setTab('received')}
        >
          Ricevute
        </button>
      </nav>
      {tab === 'issued' && isAdmin ? <IssuedTab me={me} /> : <ReceivedTab me={me} />}
    </>
  );
}

function IssuedTab({ me }: { me: Me }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['grants-issued', me.current.orgId],
    queryFn: () => api<IssuedGrant[]>('/grants/issued'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['grants-issued'] });
  const act = useMutation({
    mutationFn: ({ url, body }: { url: string; body: unknown; done: string }) =>
      api(url, { method: 'POST', body }),
    onSuccess: async (_d, { done }) => {
      setNotice(done);
      await refresh();
    },
  });

  return (
    <>
      <NewGrantForm
        onDone={async () => {
          setNotice('Delega concessa.');
          await refresh();
        }}
      />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {act.isError && (
        <p className="error" role="alert">
          {describeError(act.error)}
        </p>
      )}
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {query.data && query.data.length === 0 && (
        <p className="muted">L&apos;azienda non ha concesso deleghe.</p>
      )}
      <ul className="review-list">
        {query.data?.map((g) => (
          <li key={g.id} className="card">
            <p>
              <strong>{g.grantee.name}</strong>{' '}
              <span className={`badge ${g.state === 'ACTIVE' ? '' : 'warn'}`}>
                {STATE_NAMES[g.state]}
              </span>
            </p>
            <p className="muted">
              Può {opsText(g.operations)} · fino al {formatDate(g.validUntil)}
            </p>
            {g.granteeType === 'ORGANIZATION' && (
              <div>
                <strong>Persone che possono usarla</strong>
                {g.beneficiaries.length === 0 && (
                  <p className="muted">
                    Nessuna ancora: l&apos;organizzazione delegata propone i nomi, tu li approvi.
                  </p>
                )}
                <ul className="plain">
                  {g.beneficiaries.map((b) => (
                    <li key={b.userId}>
                      {b.email ?? 'account della chat'} · {BENEFICIARY_NAMES[b.status]}{' '}
                      {b.status === 'PROPOSED' && g.state === 'ACTIVE' && (
                        <button
                          type="button"
                          className="link"
                          disabled={act.isPending}
                          onClick={() =>
                            act.mutate({
                              url: `/grants/${g.id}/beneficiaries/approve`,
                              body: { userId: b.userId },
                              done: 'Persona approvata.',
                            })
                          }
                        >
                          Approva
                        </button>
                      )}
                      {b.status !== 'REVOKED' && (
                        <button
                          type="button"
                          className="link"
                          disabled={act.isPending}
                          onClick={() =>
                            act.mutate({
                              url: `/grants/${g.id}/beneficiaries/remove`,
                              body: { userId: b.userId },
                              done: 'Persona rimossa.',
                            })
                          }
                        >
                          Rimuovi
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {g.state !== 'REVOKED' && (
              <div className="actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={act.isPending}
                  onClick={() =>
                    act.mutate({
                      url: `/grants/${g.id}/renew`,
                      body: { validUntil: endDateIn(maxMonths(g.operations)) },
                      done: `Delega rinnovata per ${maxMonths(g.operations)} mesi.`,
                    })
                  }
                >
                  Rinnova per {maxMonths(g.operations)} mesi
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={act.isPending}
                  onClick={() =>
                    act.mutate({
                      url: `/grants/${g.id}/revoke`,
                      body: {},
                      done: 'Delega revocata: l’accesso è cessato.',
                    })
                  }
                >
                  Revoca
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function NewGrantForm({ onDone }: { onDone: () => Promise<void> }) {
  const { api } = useSession();
  const [kind, setKind] = useState<'org' | 'person'>('org');
  const [target, setTarget] = useState('');
  const [operations, setOperations] = useState<GrantOperation[]>(['READ']);
  const [months, setMonths] = useState<number>(12);
  const limit = maxMonths(operations);
  const chosenMonths = Math.min(months, limit);
  const create = useMutation({
    mutationFn: () =>
      api('/grants', {
        method: 'POST',
        body: {
          grantee: kind === 'org' ? { orgId: target.trim() } : { email: target.trim() },
          operations,
          validUntil: endDateIn(chosenMonths),
        },
      }),
    onSuccess: async () => {
      setTarget('');
      await onDone();
    },
  });
  const toggle = (op: GrantOperation) =>
    setOperations((ops) =>
      op === 'READ' ? ops : ops.includes(op) ? ops.filter((o) => o !== op) : [...ops, op],
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <form className="card form" onSubmit={submit} aria-labelledby="new-grant-title">
      <h2 id="new-grant-title">Nuova delega</h2>
      <fieldset className="plain-fieldset">
        <legend>A chi</legend>
        <label className="check">
          <input type="radio" checked={kind === 'org'} onChange={() => setKind('org')} />A
          un&apos;organizzazione (es. la rete), con il suo codice
        </label>
        <label className="check">
          <input type="radio" checked={kind === 'person'} onChange={() => setKind('person')} />A una
          persona (es. un consulente), con la sua email
        </label>
      </fieldset>
      <label htmlFor="grant-target">
        {kind === 'org' ? "Codice dell'organizzazione" : 'Email della persona'}
      </label>
      <input
        id="grant-target"
        value={target}
        onChange={(e) => {
          setTarget(e.target.value);
          create.reset();
        }}
      />
      <fieldset className="plain-fieldset">
        <legend>Che cosa può fare</legend>
        {OFFERED_OPERATIONS.map((op) => (
          <label key={op} className="check">
            <input
              type="checkbox"
              checked={operations.includes(op)}
              disabled={op === 'READ'}
              onChange={() => toggle(op)}
            />
            {OPERATION_LABELS[op]}
          </label>
        ))}
      </fieldset>
      <label htmlFor="grant-months">Durata</label>
      <select
        id="grant-months"
        value={chosenMonths}
        onChange={(e) => setMonths(Number(e.target.value))}
      >
        {DURATIONS.filter((d) => d <= limit).map((d) => (
          <option key={d} value={d}>
            {d === 1 ? '1 mese' : `${d} mesi`}
          </option>
        ))}
      </select>
      <p className="muted">Scade il {formatDate(endDateIn(chosenMonths))}.</p>
      <button type="submit" disabled={target.trim().length < 5 || create.isPending}>
        Concedi la delega
      </button>
      {create.isError && (
        <p className="error" role="alert">
          {describeError(create.error)}
        </p>
      )}
    </form>
  );
}

function ReceivedTab({ me }: { me: Me }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = me.current.role === 'ADMIN';
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['grants-received', me.current.orgId],
    queryFn: () => api<ReceivedGrant[]>('/grants/received'),
  });
  const members = useQuery({
    queryKey: ['members', me.current.orgId],
    queryFn: () => api<Member[]>('/members'),
    enabled: isAdmin,
  });
  const propose = useMutation({
    mutationFn: ({ grantId, userId }: { grantId: string; userId: string }) =>
      api(`/grants/${grantId}/beneficiaries`, { method: 'POST', body: { userId } }),
    onSuccess: async () => {
      setNotice("Persona proposta: l'azienda che ha concesso la delega deve approvarla.");
      await queryClient.invalidateQueries({ queryKey: ['grants-received'] });
    },
  });
  const activeMembers = (members.data ?? []).filter((m) => m.status === 'ACTIVE');

  return (
    <>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {propose.isError && (
        <p className="error" role="alert">
          {describeError(propose.error)}
        </p>
      )}
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {query.data && query.data.length === 0 && <p className="muted">Nessuna delega ricevuta.</p>}
      <ul className="review-list">
        {query.data?.map((g) => {
          const named = new Set(
            g.beneficiaries.filter((b) => b.status !== 'REVOKED').map((b) => b.userId),
          );
          return (
            <li key={g.id} className="card">
              <p>
                <strong>{g.grantor.name}</strong>{' '}
                <span className={`badge ${g.state === 'ACTIVE' ? '' : 'warn'}`}>
                  {STATE_NAMES[g.state]}
                </span>
              </p>
              <p className="muted">
                {g.granteeType === 'USER' ? 'A te' : "All'organizzazione"} · puoi{' '}
                {opsText(g.operations)} · fino al {formatDate(g.validUntil)}
              </p>
              {g.usable ? (
                <Link to={`/deleghe/${g.id}`} className="button">
                  Apri le pratiche di {g.grantor.name}
                </Link>
              ) : (
                g.state === 'ACTIVE' &&
                g.granteeType === 'ORGANIZATION' && (
                  <p className="muted">
                    Per usarla devi essere tra le persone approvate da {g.grantor.name}.
                  </p>
                )
              )}
              {g.granteeType === 'ORGANIZATION' && (
                <>
                  <ul className="plain">
                    {g.beneficiaries.map((b) => (
                      <li key={b.userId}>
                        {b.email ?? 'account della chat'} · {BENEFICIARY_NAMES[b.status]}
                      </li>
                    ))}
                  </ul>
                  {isAdmin && g.state === 'ACTIVE' && (
                    <label>
                      Proponi una persona
                      <select
                        value=""
                        disabled={propose.isPending}
                        onChange={(e) => {
                          if (e.target.value) {
                            setNotice(null);
                            propose.mutate({ grantId: g.id, userId: e.target.value });
                          }
                        }}
                      >
                        <option value="">Scegli…</option>
                        {activeMembers
                          .filter((m) => !named.has(m.userId))
                          .map((m) => (
                            <option key={m.userId} value={m.userId}>
                              {m.email ?? 'account della chat'}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Work on the practices of another organization through a delegation: always with the name of
 * that organization in view, only the delegated operations offered.
 */
export function DelegatedPracticesPage() {
  const { grantId = '' } = useParams();
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['delegated', grantId, page],
    queryFn: () =>
      api<DelegatedPage>(
        `/grants/${grantId}/practices?page=${page}&limit=20&sortBy=updatedAt&sortOrder=desc`,
      ),
    placeholderData: keepPreviousData,
  });
  const move = useMutation({
    mutationFn: ({ id, nextState }: { id: string; nextState: string }) =>
      api(`/grants/${grantId}/practices/${id}/transition`, {
        method: 'POST',
        body: { nextState },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['delegated', grantId] }),
    onError: (err: unknown) => setError(describeError(err)),
  });
  const exportCsv = useMutation({
    mutationFn: () =>
      api<{ csv: string; title: string; count: number }>(`/grants/${grantId}/export`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (result) => {
      if (result.count === 0) return;
      const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFileName(result.title);
      link.click();
      URL.revokeObjectURL(url);
    },
    onError: (err: unknown) => setError(describeError(err)),
  });
  const data = query.data;
  const canUpdate = data?.delegation.operations.includes('UPDATE') ?? false;
  const canExport = data?.delegation.operations.includes('EXPORT') ?? false;
  const canCreate = data?.delegation.operations.includes('CREATE') ?? false;

  return (
    <>
      <p>
        <Link to="/deleghe">← Deleghe</Link>
      </p>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {data && (
        <>
          <p className="notice banner" role="note">
            Stai lavorando sui dati di <strong>{data.delegation.grantorName}</strong> per delega,
            fino al {formatDate(data.delegation.validUntil)}. Ogni operazione resta nel suo registro
            attività.
          </p>
          <div className="page-head">
            <h1>Pratiche di {data.delegation.grantorName}</h1>
            {canExport && (
              <button
                type="button"
                className="secondary"
                disabled={exportCsv.isPending}
                onClick={() => exportCsv.mutate()}
              >
                Esporta CSV
              </button>
            )}
          </div>
          {canCreate && data.module && (
            <DelegatedNewPractice
              grantId={grantId}
              module={data.module}
              onDone={() => queryClient.invalidateQueries({ queryKey: ['delegated', grantId] })}
            />
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {data.items.length === 0 && <p className="muted">Nessuna pratica.</p>}
          {data.items.length > 0 && (
            <table className="list cards">
              <thead>
                <tr>
                  <th scope="col">Pratica</th>
                  <th scope="col">Stato</th>
                  <th scope="col">Aggiornata</th>
                  {canUpdate && (
                    <th scope="col">
                      <span className="visually-hidden">Azioni</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Pratica">
                      <Link to={`/deleghe/${grantId}/pratiche/${p.id}`}>{p.name}</Link>
                    </td>
                    <td data-label="Stato">{STATE_LABELS[p.status]}</td>
                    <td data-label="Aggiornata">{formatDate(p.updatedAt)}</td>
                    {canUpdate && (
                      <td data-label="Azioni">
                        <span className="actions">
                          {NEXT_STATES[p.status].map((s) => (
                            <button
                              key={s}
                              type="button"
                              className="secondary"
                              disabled={move.isPending}
                              onClick={() => {
                                setError(null);
                                move.mutate({ id: p.id, nextState: s });
                              }}
                            >
                              {TRANSITION_LABELS[s]}
                            </button>
                          ))}
                        </span>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.totalPages > 1 && (
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
        </>
      )}
    </>
  );
}

/**
 * AGX-04: one practice of another organization, worked on through a delegation: its documents
 * (download with READ; upload, check of the data, state and step with UPDATE). Every request is
 * checked against the delegation and recorded in that organization's log.
 */
export function DelegatedPracticeDetailPage() {
  const { grantId = '', practiceId = '' } = useParams();
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<PracticeState | null>(null);
  const key = ['delegated-practice', grantId, practiceId] as const;
  const base = `/grants/${grantId}/practices/${practiceId}`;
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<DelegatedPracticeDetail>(base),
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: key });
    await queryClient.invalidateQueries({ queryKey: ['delegated', grantId] });
  };
  const transition = useMutation({
    mutationFn: (nextState: PracticeState) =>
      api(`${base}/transition`, { method: 'POST', body: { nextState } }),
    onSuccess: async () => {
      setConfirm(null);
      await refresh();
    },
  });
  const subState = useMutation({
    mutationFn: (value: string | null) =>
      api(`${base}/sub-state`, { method: 'POST', body: { subState: value } }),
    onSuccess: refresh,
  });

  const back = (
    <p>
      <Link to={`/deleghe/${grantId}`}>← Pratiche per delega</Link>
    </p>
  );
  if (query.isPending) return <p className="muted">Caricamento…</p>;
  if (query.isError) {
    return (
      <>
        {back}
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      </>
    );
  }
  const p = query.data;
  const canUpdate = p.delegation.operations.includes('UPDATE');
  const type = p.module.practiceTypes.find((t) => t.kind === p.kind);
  const steps = type?.subStates.filter((s) => s.during.includes(p.status)) ?? [];
  const currentStep = type?.subStates.find((s) => s.key === p.subState);
  const fields = type ? shownFields(type, p.fields) : [];
  const next = canUpdate ? NEXT_STATES[p.status] : [];

  return (
    <>
      {back}
      <p className="notice banner" role="note">
        Stai lavorando sui dati di <strong>{p.delegation.grantorName}</strong> per delega, fino al{' '}
        {formatDate(p.delegation.validUntil)}. Ogni operazione resta nel suo registro attività.
      </p>
      <div className="page-head">
        <h1>{p.name}</h1>
        <span className={`state state-${p.status.toLowerCase()}`}>{STATE_LABELS[p.status]}</span>
      </div>
      <section className="card">
        <dl className="facts">
          <dt>Tipo</dt>
          <dd>{kindLabel(p)}</dd>
          {fields.map((f) => (
            <Fragment key={f.key}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </Fragment>
          ))}
          {currentStep && (
            <>
              <dt>Fase</dt>
              <dd>{currentStep.label}</dd>
            </>
          )}
          <dt>Aggiornata</dt>
          <dd>{formatDate(p.updatedAt)}</dd>
        </dl>
        {next.length > 0 && (
          <div className="actions">
            {confirm ? (
              <>
                <span>Confermi «{TRANSITION_LABELS[confirm]}» per questa pratica?</span>
                <button
                  type="button"
                  disabled={transition.isPending}
                  onClick={() => transition.mutate(confirm)}
                >
                  Conferma
                </button>
                <button type="button" className="link" onClick={() => setConfirm(null)}>
                  Annulla
                </button>
              </>
            ) : (
              next.map((s) => (
                <button key={s} type="button" className="secondary" onClick={() => setConfirm(s)}>
                  {TRANSITION_LABELS[s]}
                </button>
              ))
            )}
          </div>
        )}
        {transition.isError && (
          <p className="error" role="alert">
            {describeError(transition.error)}
          </p>
        )}
        {canUpdate && steps.length > 0 && (
          <div className="actions">
            <label htmlFor="sub-state">Fase</label>
            <select
              id="sub-state"
              value={currentStep?.key ?? ''}
              disabled={subState.isPending}
              onChange={(e) => subState.mutate(e.target.value || null)}
            >
              <option value="">Nessuna</option>
              {steps.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {subState.isError && (
          <p className="error" role="alert">
            {describeError(subState.error)}
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="attachments-title">
        <h2 id="attachments-title">Allegati</h2>
        {p.attachments.length === 0 && <p className="muted">Nessun allegato.</p>}
        <ul className="attachments">
          {p.attachments.map((a) => (
            <AttachmentItem
              key={a.id}
              practiceId={practiceId}
              attachment={a}
              basePath={base}
              refreshKey={key}
              canValidate={canUpdate}
            />
          ))}
        </ul>
        {canUpdate && <UploadForm practiceId={practiceId} basePath={base} refreshKey={key} />}
      </section>
    </>
  );
}

/** AGX-04: opening a practice for the organization that gave the delegation. */
function DelegatedNewPractice({
  grantId,
  module,
  onDone,
}: {
  grantId: string;
  module: CurrentModule;
  onDone: () => Promise<void>;
}) {
  const { api } = useSession();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [chosenKind, setKind] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const type =
    module.practiceTypes.find((t) => t.kind === (chosenKind ?? module.defaultKind)) ??
    module.practiceTypes[0];
  const create = useMutation({
    mutationFn: () => {
      const fields = fieldValues(type, values);
      return api<Practice>(`/grants/${grantId}/practices`, {
        method: 'POST',
        body: {
          name: name.trim(),
          kind: type.kind,
          ...(Object.keys(fields).length > 0 ? { fields } : {}),
        },
      });
    },
    onSuccess: async () => {
      setName('');
      setValues({});
      setOpen(false);
      await onDone();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Nuova pratica
      </button>
    );
  }
  return (
    <form className="card form" onSubmit={submit} aria-label="Nuova pratica per delega">
      <label htmlFor="delegated-name">Nome</label>
      <input
        id="delegated-name"
        required
        maxLength={200}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <label htmlFor="delegated-kind">Tipo</label>
      <select
        id="delegated-kind"
        value={type.kind}
        onChange={(e) => {
          setKind(e.target.value);
          setValues({});
        }}
      >
        {module.practiceTypes.map((t) => (
          <option key={t.kind} value={t.kind}>
            {t.label}
          </option>
        ))}
      </select>
      <PracticeFieldInputs
        type={type}
        values={values}
        idPrefix="delegated-field"
        onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
      />
      <p className="muted">
        La pratica sarà dell’organizzazione che ti ha dato la delega, intestata a chi l’ha concessa.
      </p>
      <div className="actions">
        <button
          type="submit"
          disabled={!name.trim() || missingRequired(type, values) || create.isPending}
        >
          Crea pratica
        </button>
        <button type="button" className="link" onClick={() => setOpen(false)}>
          Annulla
        </button>
      </div>
      {create.isError && (
        <p className="error" role="alert">
          {describeError(create.error)}
        </p>
      )}
    </form>
  );
}
