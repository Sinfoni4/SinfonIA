import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';

import { ApiError, describeError, type Me } from '../api/client';
import { formatDate, type DocumentRequest } from '../api/practices';
import { useSession } from '../session/session';

/** An open request of the own organization (staff queue). */
type OwnRequest = DocumentRequest & { practiceName: string | null };

/** An open request of a company that gave a delegation (network queue). */
type QueuedRequest = OwnRequest & { grantId: string; orgName: string; askedByUs: boolean };

type NetworkQueue = { requests: QueuedRequest[]; organizations: number };

const DAY_MS = 86_400_000;

/** Days from today to the date (negative: past), on the Italian calendar day. */
export function daysTo(dueDate: string, now = new Date()): number {
  const today = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
  return Math.round(
    (Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
  );
}

export function DueBadge({ dueDate, now }: { dueDate: string | null; now?: Date }) {
  if (!dueDate) return <span className="muted">senza data</span>;
  const days = daysTo(dueDate, now);
  const text = formatDate(`${dueDate}T12:00:00Z`);
  if (days < 0) return <span className="badge warn">scaduta il {text}</span>;
  if (days === 0) return <span className="badge warn">oggi</span>;
  if (days <= 2) return <span className="badge warn">{text}</span>;
  return <span>{text}</span>;
}

const what = (r: DocumentRequest) => r.expectedLabel ?? r.message;

/**
 * The open requests for documents in one place: those of the own organization and, for whoever
 * works through delegations (the network), those of every company that gave one, nearest date
 * first.
 */
export function RequestsPage({ me }: { me: Me }) {
  const { api } = useSession();
  const on = (feature: string) => !(me.current.disabledFeatures ?? []).includes(feature);
  const staff = me.current.role !== 'MEMBER';
  const [onlyOurs, setOnlyOurs] = useState(false);

  const network = useQuery({
    queryKey: ['requests', 'network', me.current.orgId],
    queryFn: () => api<NetworkQueue>('/grants/document-requests'),
    enabled: on('delegations'),
  });
  const own = useQuery({
    queryKey: ['requests', 'own', me.current.orgId],
    queryFn: () => api<OwnRequest[]>('/document-requests'),
    enabled: staff,
  });
  const hidden = (err: unknown) =>
    err instanceof ApiError && (err.status === 403 || err.status === 404);
  const networkRows = (network.data?.requests ?? []).filter((r) => !onlyOurs || r.askedByUs);

  return (
    <>
      <h1>Richieste di documenti</h1>
      {on('delegations') && !hidden(network.error) && (
        <section aria-labelledby="network-requests">
          <h2 id="network-requests">Aziende che ti hanno dato una delega</h2>
          {network.isError && (
            <p className="error" role="alert">
              {describeError(network.error)}
            </p>
          )}
          {network.isPending && <p className="muted">Caricamento…</p>}
          {network.data && (
            <>
              <p className="muted">
                {network.data.requests.length === 0
                  ? network.data.organizations === 0
                    ? 'Nessuna delega attiva che puoi usare.'
                    : 'Nessuna richiesta aperta.'
                  : `${network.data.requests.length} richieste aperte in ${network.data.organizations} aziende, la scadenza più vicina per prima.`}
              </p>
              {network.data.requests.some((r) => r.askedByUs) && (
                <label>
                  <input
                    type="checkbox"
                    checked={onlyOurs}
                    onChange={(e) => setOnlyOurs(e.target.checked)}
                  />{' '}
                  Solo quelle chieste da noi
                </label>
              )}
              {networkRows.length > 0 && (
                <table className="list cards">
                  <thead>
                    <tr>
                      <th scope="col">Scadenza</th>
                      <th scope="col">Azienda</th>
                      <th scope="col">Pratica</th>
                      <th scope="col">Documento</th>
                      <th scope="col">Chiesta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {networkRows.map((r) => (
                      <tr key={r.id}>
                        <td data-label="Scadenza">
                          <DueBadge dueDate={r.dueDate} />
                        </td>
                        <td data-label="Azienda">{r.orgName}</td>
                        <td data-label="Pratica">
                          <Link to={`/deleghe/${r.grantId}/pratiche/${r.practiceId}`}>
                            {r.practiceName ?? 'senza nome'}
                          </Link>
                        </td>
                        <td data-label="Documento">{what(r)}</td>
                        <td data-label="Chiesta">
                          {r.askedByUs ? 'da noi' : "dall'azienda"} il {formatDate(r.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </section>
      )}
      {staff && !hidden(own.error) && (
        <section aria-labelledby="own-requests">
          <h2 id="own-requests">La tua organizzazione</h2>
          {own.isError && (
            <p className="error" role="alert">
              {describeError(own.error)}
            </p>
          )}
          {own.isPending && <p className="muted">Caricamento…</p>}
          {own.data && own.data.length === 0 && <p className="muted">Nessuna richiesta aperta.</p>}
          {own.data && own.data.length > 0 && (
            <table className="list cards">
              <thead>
                <tr>
                  <th scope="col">Scadenza</th>
                  <th scope="col">Pratica</th>
                  <th scope="col">Documento</th>
                  <th scope="col">Chiesta il</th>
                </tr>
              </thead>
              <tbody>
                {[...own.data]
                  .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'))
                  .map((r) => (
                    <tr key={r.id}>
                      <td data-label="Scadenza">
                        <DueBadge dueDate={r.dueDate} />
                      </td>
                      <td data-label="Pratica">
                        <Link to={`/pratiche/${r.practiceId}`}>
                          {r.practiceName ?? 'senza nome'}
                        </Link>
                      </td>
                      <td data-label="Documento">{what(r)}</td>
                      <td data-label="Chiesta il">{formatDate(r.createdAt)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      <p className="muted">
        Chi deve mandare il documento riceve un promemoria in chat due giorni prima della scadenza e
        il giorno stesso.
      </p>
    </>
  );
}
