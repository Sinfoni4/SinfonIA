import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  ASSISTANCE_STATUS_LABELS,
  assistanceQuery,
  CHAT_CHANNEL_LABELS,
  contactLines,
  TOPIC_LABELS,
  type AssistanceFilter,
  type AssistanceItem,
  type AssistancePage as Page,
} from '../api/assistance';
import { describeError, type Me } from '../api/client';
import { formatDateTime } from '../api/organization';
import { useSession } from '../session/session';

/**
 * H10: the requests sent from the chat with «parla con un operatore». An administrator or operator
 * takes one in charge (the person is told in chat), contacts the person, then closes it.
 */
export function AssistancePage({ me }: { me: Me }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AssistanceFilter>('open');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['assistance', me.current.orgId, status, page],
    queryFn: () => api<Page>(assistanceQuery(status, page)),
    placeholderData: keepPreviousData,
    // assistance.manage: ADMIN and OPERATOR (the backend decides anyway).
    enabled: me.current.role !== 'MEMBER',
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'take' | 'close' }) =>
      api(`/assistance/${id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: async (_data, { action }) => {
      setNotice(
        action === 'take'
          ? 'Richiesta presa in carico: la persona riceve un avviso in chat.'
          : 'Richiesta chiusa: la persona riceve un avviso in chat.',
      );
      await queryClient.invalidateQueries({ queryKey: ['assistance'] });
    },
  });
  const data = query.data;

  const show = (next: AssistanceFilter) => {
    setStatus(next);
    setPage(1);
    setNotice(null);
  };

  if (me.current.role === 'MEMBER') {
    return (
      <>
        <h1>Assistenza</h1>
        <p className="muted">
          Per chiedere aiuto scrivi «operatore» nella chat: la richiesta arriva agli operatori.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Richieste di assistenza</h1>
      <nav className="tabs" aria-label="Stato delle richieste">
        <button
          type="button"
          className={`link ${status === 'open' ? 'active' : ''}`}
          aria-pressed={status === 'open'}
          onClick={() => show('open')}
        >
          Da gestire{data && status === 'open' ? ` (${data.total})` : ''}
        </button>
        <button
          type="button"
          className={`link ${status === 'closed' ? 'active' : ''}`}
          aria-pressed={status === 'closed'}
          onClick={() => show('closed')}
        >
          Chiuse
        </button>
      </nav>
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
      {data && data.items.length === 0 && (
        <p className="muted">
          {status === 'open' ? 'Nessuna richiesta da gestire.' : 'Nessuna richiesta chiusa.'}
        </p>
      )}
      {data && data.items.length > 0 && (
        <ul className="review-list">
          {data.items.map((item) => (
            <RequestCard
              key={item.id}
              item={item}
              busy={act.isPending}
              onAction={(action) => {
                setNotice(null);
                act.mutate({ id: item.id, action });
              }}
            />
          ))}
        </ul>
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
        La chat non conserva i messaggi: contatta la persona con i recapiti indicati. La risposta in
        chat dalla dashboard arriverà con la chat dal vivo.
      </p>
    </>
  );
}

function RequestCard({
  item,
  busy,
  onAction,
}: {
  item: AssistanceItem;
  busy: boolean;
  onAction: (action: 'take' | 'close') => void;
}) {
  return (
    <li className="card">
      <div className="attachment-head">
        <span>
          <strong>{TOPIC_LABELS[item.topic]}</strong>
          <span className="muted">
            {' '}
            · da {CHAT_CHANNEL_LABELS[item.channel]} · {formatDateTime(item.createdAt)}
          </span>
        </span>
        <span className={`badge ${item.status === 'OPEN' ? 'warn' : ''}`}>
          {ASSISTANCE_STATUS_LABELS[item.status]}
        </span>
      </div>
      <ul className="plain">
        {contactLines(item).map((line) => (
          <li key={line}>{line}</li>
        ))}
        <li className="muted">
          {item.requester.practices === 1 ? '1 pratica' : `${item.requester.practices} pratiche`}{' '}
          nell&apos;organizzazione
        </li>
        {item.takenAt && (
          <li className="muted">
            In carico dal {formatDateTime(item.takenAt)}
            {item.takenByEmail ? ` · ${item.takenByEmail}` : ''}
          </li>
        )}
        {item.closedAt && (
          <li className="muted">
            Chiusa il {formatDateTime(item.closedAt)}
            {item.closedByEmail ? ` · ${item.closedByEmail}` : ''}
          </li>
        )}
      </ul>
      {item.status !== 'CLOSED' && (
        <div className="actions">
          {item.status === 'OPEN' && (
            <button type="button" disabled={busy} onClick={() => onAction('take')}>
              Prendi in carico
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => onAction('close')}
          >
            Chiudi
          </button>
        </div>
      )}
    </li>
  );
}
