import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';

import { describeError, type Me } from '../api/client';
import { CATEGORY_LABELS, type DeadlineCategory } from '../api/compliance';
import {
  KIND_NAMES,
  MEMBERSHIP_STATUS_LABELS,
  PERIODS,
  showProtected,
  statsQuery,
  type MemberOrganization,
  type MyNetwork,
  type NetworkStats,
} from '../api/network';
import { NETWORK_TYPES, ORGANIZATION_TYPE_LABELS } from '../api/organization';
import { formatDate, STATE_LABELS } from '../api/practices';
import { useSession } from '../session/session';

function isNetwork(me: Me): boolean {
  const type = me.organizations.find((o) => o.orgId === me.current.orgId)?.type;
  return type !== undefined && NETWORK_TYPES.includes(type);
}

function NotForThisOrganization({ title, text }: { title: string; text: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="muted">{text}</p>
    </>
  );
}

/**
 * P16 (MF9): the member companies of a network, with their minimal profile only; invitations by
 * membership code and end of a membership. Administrators of the network.
 */
export function NetworkMembersPage({ me }: { me: Me }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const allowed = me.current.role === 'ADMIN' && isNetwork(me);
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [ending, setEnding] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['network-members', me.current.orgId],
    queryFn: () => api<MemberOrganization[]>('/network/members'),
    enabled: allowed,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['network-members'] });
  const invite = useMutation({
    mutationFn: (orgId: string) => api('/network/members', { method: 'POST', body: { orgId } }),
    onSuccess: async () => {
      setCode('');
      setNotice("Invito inviato: l'azienda lo conferma dalla pagina Adesioni.");
      await refresh();
    },
  });
  const end = useMutation({
    mutationFn: (relationId: string) =>
      api(`/network/members/${relationId}/end`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      setEnding(null);
      setNotice('Adesione chiusa.');
      await refresh();
    },
  });

  if (!allowed) {
    return (
      <NotForThisOrganization
        title="Aderenti"
        text="Questa pagina è per gli amministratori di reti, consorzi e associazioni."
      />
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    invite.mutate(code.trim());
  };
  const members = query.data ?? [];
  const active = members.filter((m) => m.status === 'ACTIVE');
  const pending = members.filter((m) => m.status === 'PENDING');

  return (
    <>
      <div className="page-head">
        <h1>Aderenti</h1>
        <Link to="/rete/statistiche" className="button secondary">
          Statistiche
        </Link>
      </div>
      <p className="muted">
        Della rete vedi solo nome, comune e settore delle aziende aderenti e le statistiche
        aggregate. Per lavorare sui dati di un&apos;azienda serve una delega concessa da lei.
      </p>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <form className="card form" onSubmit={submit} aria-labelledby="invite-title">
        <h2 id="invite-title">Invita un&apos;azienda</h2>
        <label htmlFor="member-code">Codice di adesione dell&apos;azienda</label>
        <input
          id="member-code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            invite.reset();
          }}
          placeholder="lo trova l'amministratore dell'azienda nella pagina Adesioni"
        />
        <button type="submit" disabled={code.trim().length < 36 || invite.isPending}>
          Invita
        </button>
        {invite.isError && (
          <p className="error" role="alert">
            {describeError(invite.error)}
          </p>
        )}
      </form>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {end.isError && (
        <p className="error" role="alert">
          {describeError(end.error)}
        </p>
      )}
      {query.data && (
        <>
          <h2>Aziende aderenti ({active.length})</h2>
          {active.length === 0 && <p className="muted">Nessuna azienda aderente.</p>}
          <MemberTable
            rows={active}
            ending={ending}
            busy={end.isPending}
            onEnd={setEnding}
            onConfirmEnd={(id) => end.mutate(id)}
          />
          {pending.length > 0 && (
            <>
              <h2>Inviti in attesa ({pending.length})</h2>
              <MemberTable
                rows={pending}
                ending={ending}
                busy={end.isPending}
                onEnd={setEnding}
                onConfirmEnd={(id) => end.mutate(id)}
              />
            </>
          )}
        </>
      )}
    </>
  );
}

function MemberTable({
  rows,
  ending,
  busy,
  onEnd,
  onConfirmEnd,
}: {
  rows: MemberOrganization[];
  ending: string | null;
  busy: boolean;
  onEnd: (id: string | null) => void;
  onConfirmEnd: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <table className="list cards">
      <thead>
        <tr>
          <th scope="col">Azienda</th>
          <th scope="col">Comune</th>
          <th scope="col">Settore</th>
          <th scope="col">Stato</th>
          <th scope="col">
            <span className="visually-hidden">Azioni</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.relationId}>
            <td data-label="Azienda">
              {m.name}
              <span className="muted"> · {ORGANIZATION_TYPE_LABELS[m.type]}</span>
            </td>
            <td data-label="Comune">{m.municipality ?? '—'}</td>
            <td data-label="Settore">{m.sector ?? '—'}</td>
            <td data-label="Stato">
              {MEMBERSHIP_STATUS_LABELS[m.status]}
              {m.startedAt
                ? ` dal ${formatDate(m.startedAt)}`
                : ` (invitata il ${formatDate(m.invitedAt)})`}
            </td>
            <td data-label="Azioni">
              <span className="actions">
                {ending === m.relationId ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onConfirmEnd(m.relationId)}
                    >
                      Conferma
                    </button>
                    <button type="button" className="link" onClick={() => onEnd(null)}>
                      Annulla
                    </button>
                  </>
                ) : (
                  <button type="button" className="secondary" onClick={() => onEnd(m.relationId)}>
                    {m.status === 'PENDING' ? 'Ritira invito' : 'Chiudi adesione'}
                  </button>
                )}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** P17 (MF9, D4): aggregate statistics of the network, for fixed periods only. */
export function NetworkStatsPage({ me }: { me: Me }) {
  const { api } = useSession();
  const allowed = me.current.role !== 'MEMBER' && isNetwork(me);
  const [periodIndex, setPeriodIndex] = useState(0);
  const period = PERIODS[periodIndex];
  const query = useQuery({
    queryKey: ['network-stats', me.current.orgId, period.kind, period.previous],
    queryFn: () => api<NetworkStats>(statsQuery(period.kind, period.previous)),
    enabled: allowed,
  });

  if (!allowed) {
    return (
      <NotForThisOrganization
        title="Statistiche della rete"
        text="Questa pagina è per amministratori e operatori di reti, consorzi e associazioni."
      />
    );
  }
  const s = query.data;

  return (
    <>
      <h1>Statistiche della rete</h1>
      <label htmlFor="stats-period">Periodo</label>
      <select
        id="stats-period"
        value={periodIndex}
        onChange={(e) => setPeriodIndex(Number(e.target.value))}
      >
        {PERIODS.map((p, i) => (
          <option key={p.label} value={i}>
            {p.label}
          </option>
        ))}
      </select>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {s && (
        <>
          <p className="muted">
            Dal {formatDate(s.period.from)} al {formatDate(s.period.to)} · {s.members.inPeriod}{' '}
            aziende aderenti nel periodo, {s.members.activeNow} oggi.
          </p>
          {!s.members.sufficient && (
            <p className="notice" role="status">
              Le statistiche compaiono quando la rete ha almeno {s.members.threshold} aziende
              aderenti nel periodo: con meno, i valori potrebbero far riconoscere una singola
              azienda.
            </p>
          )}
          <div className="stats-grid">
            <StatCard
              title="Pratiche aperte nel periodo, per stato"
              rows={s.practicesByStatus.map((p) => [
                STATE_LABELS[p.status],
                showProtected(p.value),
              ])}
            />
            <StatCard
              title="Pratiche aperte nel periodo, per tipo"
              rows={s.practicesByKind.map((p) => [
                KIND_NAMES[p.kind] ?? p.kind,
                showProtected(p.value),
              ])}
            />
            <StatCard
              title="Giorni medi per completare una pratica"
              rows={s.completionDays.map((p) => [
                KIND_NAMES[p.kind] ?? p.kind,
                showProtected(p.value, ' giorni'),
              ])}
            />
            <StatCard
              title="Aziende con scadenze (oggi)"
              rows={s.deadlines.map((d) => [
                CATEGORY_LABELS[d.category as DeadlineCategory] ?? d.category,
                `${showProtected(d.overdue)} scadute · ${showProtected(d.dueSoon)} entro 30 giorni`,
              ])}
            />
            <StatCard
              title="Certificazione biologica valida (oggi)"
              rows={[
                [
                  'Aziende',
                  s.organic.total === null
                    ? 'non disponibile'
                    : `${showProtected(s.organic.valid)} su ${s.organic.total}`,
                ],
              ]}
            />
            <StatCard
              title="Documenti"
              rows={[
                ['Caricati nel periodo', showProtected(s.documents.uploaded)],
                [
                  'Letti senza bisogno di verifica',
                  showProtected(s.documents.readWithoutCheckPercent, '%'),
                ],
              ]}
            />
            <StatCard
              title="Uso dei canali nel periodo"
              rows={[
                ["Richieste all'assistente in chat", showProtected(s.channels.chatRequests)],
                ['Accessi alla dashboard', showProtected(s.channels.dashboardLogins)],
              ]}
            />
          </div>
          <p className="muted">
            Ogni valore è calcolato su almeno {s.members.threshold} aziende; i conteggi di 1 o 2
            aziende compaiono come «meno di 3». Ogni consultazione resta nel registro attività.
          </p>
        </>
      )}
    </>
  );
}

function StatCard({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">Nessun dato nel periodo.</p>
      ) : (
        <dl className="facts">
          {rows.map(([label, value]) => (
            <div key={label} className="fact">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/**
 * P18 (MF9): the networks of the organization. The administrator shares the membership code,
 * confirms or refuses invitations and can leave a network.
 */
export function MembershipsPage({ me }: { me: Me }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const allowed = me.current.role === 'ADMIN';
  const [notice, setNotice] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['memberships', me.current.orgId],
    queryFn: () => api<MyNetwork[]>('/memberships'),
    enabled: allowed,
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'confirm' | 'refuse' | 'leave' }) =>
      api(`/memberships/${id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: async (_d, { action }) => {
      setLeaving(null);
      setNotice(
        action === 'confirm'
          ? 'Adesione confermata.'
          : action === 'refuse'
            ? 'Invito rifiutato.'
            : 'Hai lasciato la rete.',
      );
      await queryClient.invalidateQueries({ queryKey: ['memberships'] });
    },
  });

  if (!allowed) {
    return (
      <NotForThisOrganization
        title="Adesioni"
        text="Le adesioni alle reti le gestiscono gli amministratori dell'azienda."
      />
    );
  }
  const rows = query.data ?? [];
  const pending = rows.filter((r) => r.status === 'PENDING');
  const active = rows.filter((r) => r.status === 'ACTIVE');

  return (
    <>
      <h1>Adesioni alle reti</h1>
      <section className="card">
        <h2>Codice di adesione</h2>
        <p>
          Comunicalo alla rete, al consorzio o all&apos;associazione a cui vuoi aderire: ti manderà
          un invito da confermare qui.
        </p>
        <p>
          <code>{me.current.orgId}</code>{' '}
          <button
            type="button"
            className="link"
            onClick={() => void navigator.clipboard?.writeText(me.current.orgId)}
          >
            Copia
          </button>
        </p>
        <p className="muted">
          Una rete vede solo nome, comune e settore dell&apos;azienda e la include nelle sue
          statistiche aggregate (almeno 5 aziende per valore). Non vede pratiche, documenti né
          persone, a meno che tu non le conceda una delega.
        </p>
      </section>
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
      {pending.length > 0 && (
        <>
          <h2>Inviti da confermare</h2>
          <ul className="review-list">
            {pending.map((r) => (
              <li key={r.relationId} className="card">
                <p>
                  <strong>{r.name}</strong>{' '}
                  <span className="muted">
                    · {ORGANIZATION_TYPE_LABELS[r.type]} · invito del {formatDate(r.invitedAt)}
                  </span>
                </p>
                <div className="actions">
                  <button
                    type="button"
                    disabled={act.isPending}
                    onClick={() => act.mutate({ id: r.relationId, action: 'confirm' })}
                  >
                    Conferma l&apos;adesione
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={act.isPending}
                    onClick={() => act.mutate({ id: r.relationId, action: 'refuse' })}
                  >
                    Rifiuta
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {query.data && (
        <>
          <h2>Reti a cui aderisci</h2>
          {active.length === 0 && <p className="muted">Nessuna adesione attiva.</p>}
          <ul className="review-list">
            {active.map((r) => (
              <li key={r.relationId} className="card">
                <p>
                  <strong>{r.name}</strong>{' '}
                  <span className="muted">
                    · {ORGANIZATION_TYPE_LABELS[r.type]}
                    {r.startedAt ? ` · dal ${formatDate(r.startedAt)}` : ''}
                  </span>
                </p>
                <div className="actions">
                  {leaving === r.relationId ? (
                    <>
                      <span>Confermi di lasciare la rete?</span>
                      <button
                        type="button"
                        disabled={act.isPending}
                        onClick={() => act.mutate({ id: r.relationId, action: 'leave' })}
                      >
                        Conferma
                      </button>
                      <button type="button" className="link" onClick={() => setLeaving(null)}>
                        Annulla
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setLeaving(r.relationId)}
                    >
                      Lascia la rete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
