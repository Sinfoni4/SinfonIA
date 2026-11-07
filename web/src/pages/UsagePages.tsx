import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { describeError, type Me } from '../api/client';
import { PERIODS, showProtected, type NetworkStats } from '../api/network';
import { formatDateTime } from '../api/organization';
import { formatDate } from '../api/practices';
import {
  formatCost,
  formatQuantity,
  usageLabel,
  usageQuery,
  type OrganizationUsage,
  type PlatformUsage,
} from '../api/usage';
import { useSession } from '../session/session';

import { ActivityTabs } from './ActivityPage';

function PeriodSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number;
  onChange: (i: number) => void;
}) {
  return (
    <div className="filters">
      <label htmlFor={id}>Periodo</label>
      <select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {PERIODS.map((p, i) => (
          <option key={p.label} value={i}>
            {p.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** AGX-07: what was done for the organization in a period, and what others did through delegations. */
export function OrganizationUsagePage({ me }: { me: Me }) {
  const { api } = useSession();
  const isAdmin = me.current.role === 'ADMIN';
  const [periodIndex, setPeriodIndex] = useState(0);
  const period = PERIODS[periodIndex];
  const query = useQuery({
    queryKey: ['usage', me.current.orgId, period.kind, period.previous],
    queryFn: () => api<OrganizationUsage>(usageQuery('/usage', period.kind, period.previous)),
    enabled: isAdmin,
    placeholderData: keepPreviousData,
  });

  if (!isAdmin) {
    return (
      <>
        <h1>Attività</h1>
        <p className="muted">Solo gli amministratori vedono i consumi dell&apos;organizzazione.</p>
      </>
    );
  }
  const u = query.data;
  const used = u?.totals.filter((t) => t.quantity !== 0) ?? [];

  return (
    <>
      <h1>Attività</h1>
      <ActivityTabs />
      <PeriodSelect id="usage-period" value={periodIndex} onChange={setPeriodIndex} />
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {u && (
        <>
          <p className="muted">
            Dal {formatDate(u.period.from)} al {formatDate(u.period.to)}.
          </p>
          <section className="card">
            <h2>Consumi del periodo</h2>
            {used.length === 0 ? (
              <p className="muted">Nessun consumo nel periodo.</p>
            ) : (
              <dl className="facts">
                {used.map((t) => (
                  <div key={t.kind} className="fact">
                    <dt>{usageLabel(t.kind)}</dt>
                    <dd>{formatQuantity(t.quantity)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          {u.byOthers.map((o) => (
            <section key={o.orgId} className="card">
              <h2>Svolti da {o.orgName} con una delega</h2>
              <dl className="facts">
                {o.items.map((i) => (
                  <div key={i.kind} className="fact">
                    <dt>{usageLabel(i.kind)}</dt>
                    <dd>{formatQuantity(i.quantity)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </>
      )}
      <p className="muted">
        Si contano le operazioni, mai il contenuto di documenti o messaggi. Il lavoro svolto da
        un&apos;altra organizzazione con una delega è compreso nei totali e indicato a parte.
      </p>
    </>
  );
}

/** AGX-07: in the network statistics, usage of the companies (aggregated) and the network's own work. */
export function NetworkUsageCards({ stats }: { stats: NetworkStats }) {
  return (
    <>
      <section className="card">
        <h2>Consumi delle aziende nel periodo</h2>
        <dl className="facts">
          {stats.usage.map((u) => (
            <div key={u.kind} className="fact">
              <dt>{usageLabel(u.kind)}</dt>
              <dd>{showProtected(u.value)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="card">
        <h2>Lavoro della rete con le deleghe</h2>
        {stats.delegatedWork.length === 0 ? (
          <p className="muted">Nessuna operazione con le deleghe nel periodo.</p>
        ) : (
          <dl className="facts">
            {stats.delegatedWork.map((d) => (
              <div key={d.kind} className="fact">
                <dt>{usageLabel(d.kind)}</dt>
                <dd>{formatQuantity(d.quantity)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </>
  );
}

/** AGX-07: usage of every organization with the internal cost; a wrong event can be reversed. */
export function PlatformUsagePage() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [periodIndex, setPeriodIndex] = useState(0);
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const period = PERIODS[periodIndex];
  const query = useQuery({
    queryKey: ['platform', 'usage', period.kind, period.previous],
    queryFn: () => api<PlatformUsage>(usageQuery('/platform/usage', period.kind, period.previous)),
    placeholderData: keepPreviousData,
  });
  const reverse = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      api(`/platform/usage/${input.id}/reverse`, {
        method: 'POST',
        body: { reason: input.reason },
      }),
    onSuccess: async () => {
      setReversing(null);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
  });
  const u = query.data;
  const used = u?.totals.filter((t) => t.quantity !== 0) ?? [];

  return (
    <>
      <h1>Consumi</h1>
      <PeriodSelect id="platform-usage-period" value={periodIndex} onChange={setPeriodIndex} />
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {u && (
        <>
          <p className="muted">
            Dal {formatDate(u.period.from)} al {formatDate(u.period.to)}.{' '}
            {u.ratesConfigured
              ? 'Il costo interno è stimato con le tariffe della configurazione (USAGE_RATES).'
              : 'Nessuna tariffa configurata (USAGE_RATES): il costo interno non è calcolato.'}
          </p>
          <section className="card">
            <h2>Totale</h2>
            {used.length === 0 ? (
              <p className="muted">Nessun consumo nel periodo.</p>
            ) : (
              <table className="list cards">
                <thead>
                  <tr>
                    <th scope="col">Voce</th>
                    <th scope="col">Quantità</th>
                    <th scope="col">Costo interno</th>
                  </tr>
                </thead>
                <tbody>
                  {used.map((t) => (
                    <tr key={t.kind}>
                      <td data-label="Voce">{usageLabel(t.kind)}</td>
                      <td data-label="Quantità">{formatQuantity(t.quantity)}</td>
                      <td data-label="Costo interno">{formatCost(t.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {u.cost !== null && <p>Costo interno stimato: {formatCost(u.cost)}</p>}
          </section>
          {u.organizations.length > 0 && (
            <section className="card">
              <h2>Per organizzazione</h2>
              <table className="list cards">
                <thead>
                  <tr>
                    <th scope="col">Organizzazione</th>
                    <th scope="col">Consumi</th>
                    <th scope="col">Costo interno</th>
                  </tr>
                </thead>
                <tbody>
                  {u.organizations.map((o) => (
                    <tr key={o.orgId}>
                      <td data-label="Organizzazione">{o.orgName}</td>
                      <td data-label="Consumi">
                        {o.items
                          .map((i) => `${usageLabel(i.kind)}: ${formatQuantity(i.quantity)}`)
                          .join(' · ')}
                      </td>
                      <td data-label="Costo interno">{formatCost(o.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {u.recent.length > 0 && (
            <section className="card">
              <h2>Ultimi eventi</h2>
              <table className="list cards">
                <thead>
                  <tr>
                    <th scope="col">Quando</th>
                    <th scope="col">Organizzazione</th>
                    <th scope="col">Voce</th>
                    <th scope="col">Quantità</th>
                    <th scope="col">Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {u.recent.map((e) => (
                    <tr key={e.id}>
                      <td data-label="Quando">{formatDateTime(e.occurredAt)}</td>
                      <td data-label="Organizzazione">
                        {e.orgName}
                        {e.actorOrgName ? ` (da ${e.actorOrgName})` : ''}
                      </td>
                      <td data-label="Voce">{usageLabel(e.kind)}</td>
                      <td data-label="Quantità">{formatQuantity(e.quantity)}</td>
                      <td data-label="Stato">
                        {e.correctionOf ? (
                          `Storno${e.reason ? `: ${e.reason}` : ''}`
                        ) : e.reversed ? (
                          'Stornato'
                        ) : reversing === e.id ? (
                          <form
                            onSubmit={(ev) => {
                              ev.preventDefault();
                              reverse.mutate({ id: e.id, reason: reason.trim() });
                            }}
                          >
                            <label>
                              Motivo dello storno
                              <input
                                value={reason}
                                onChange={(ev) => setReason(ev.target.value)}
                                minLength={3}
                                maxLength={500}
                                required
                              />
                            </label>
                            <button type="submit" disabled={reverse.isPending}>
                              Storna
                            </button>{' '}
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => {
                                setReversing(null);
                                reverse.reset();
                              }}
                            >
                              Annulla
                            </button>
                            {reverse.isError && (
                              <p className="error" role="alert">
                                {describeError(reverse.error)}
                              </p>
                            )}
                          </form>
                        ) : (
                          <button
                            type="button"
                            className="link"
                            onClick={() => {
                              setReversing(e.id);
                              setReason('');
                              reverse.reset();
                            }}
                          >
                            Storna
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
      <p className="muted">
        Un evento non si modifica mai: uno storno aggiunge un evento di segno opposto, con il
        motivo, e resta nei registri della piattaforma e dell&apos;organizzazione.
      </p>
    </>
  );
}
