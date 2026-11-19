import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { describeError } from '../api/client';
import {
  formatDate,
  type Attachment,
  type DocumentRequest,
  type ExpectedDocument,
} from '../api/practices';
import { useSession } from '../session/session';

const STATUS_TEXT: Record<DocumentRequest['status'], string> = {
  OPEN: 'aperta',
  FULFILLED: 'ricevuto',
  CANCELLED: 'annullata',
};

const STATUS_CLASS: Record<DocumentRequest['status'], string> = {
  OPEN: 'state',
  FULFILLED: 'state state-completed',
  CANCELLED: 'state',
};

/**
 * AGX-06: the requests for documents of a practice. Whoever reaches the practice sees them; who
 * checks the documents (staff, or a delegation with UPDATE) asks for one, cancels it, or links a
 * file to it when the file did not answer it by itself. Shared by one's own practices and those
 * reached through a delegation (`basePath`).
 */
export function DocumentRequests({
  practiceId,
  basePath,
  requests,
  expected,
  attachments,
  canManage,
  refreshKeys,
}: {
  practiceId: string;
  basePath?: string;
  requests: DocumentRequest[];
  expected: readonly ExpectedDocument[];
  attachments: Attachment[];
  canManage: boolean;
  refreshKeys: ReadonlyArray<readonly unknown[]>;
}) {
  const base = basePath ?? `/practices/${practiceId}`;
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [expectedKey, setExpectedKey] = useState('');
  const [message, setMessage] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    for (const key of refreshKeys) await queryClient.invalidateQueries({ queryKey: key });
  };
  const ask = useMutation({
    mutationFn: () =>
      api(`${base}/document-requests`, {
        method: 'POST',
        body: {
          expectedKey: expectedKey || null,
          message: message.trim(),
          dueDate: dueDate || null,
        },
      }),
    onSuccess: async () => {
      setAsking(false);
      setExpectedKey('');
      setMessage('');
      setDueDate('');
      await refresh();
    },
    onError: (err: unknown) => setError(describeError(err)),
  });
  const act = useMutation({
    mutationFn: ({ id, attachmentId }: { id: string; attachmentId?: string }) =>
      attachmentId
        ? api(`${base}/document-requests/${id}/fulfil`, { method: 'POST', body: { attachmentId } })
        : api(`${base}/document-requests/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: refresh,
    onError: (err: unknown) => setError(describeError(err)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    ask.mutate();
  };

  if (requests.length === 0 && !canManage) return null;
  return (
    <section className="card" aria-labelledby="requests-title">
      <h2 id="requests-title">Richieste di documenti</h2>
      {requests.length === 0 && <p className="muted">Nessuna richiesta.</p>}
      <ul className="plain">
        {requests.map((r) => (
          <li key={r.id}>
            <strong>{r.expectedLabel ?? 'Documento'}</strong>{' '}
            <span className={STATUS_CLASS[r.status]}>{STATUS_TEXT[r.status]}</span>
            <p>{r.message}</p>
            <p className="muted">
              Chiesta il {formatDate(r.createdAt)}
              {r.dueDate ? ` · entro il ${r.dueDate.split('-').reverse().join('/')}` : ''}
              {r.fulfilledAt ? ` · ricevuta il ${formatDate(r.fulfilledAt)}` : ''}
            </p>
            {canManage && r.status === 'OPEN' && (
              <div className="actions">
                {attachments.length > 0 && (
                  <>
                    <label htmlFor={`fulfil-${r.id}`}>Collega un file</label>
                    <select
                      id={`fulfil-${r.id}`}
                      value=""
                      disabled={act.isPending}
                      onChange={(e) => {
                        setError(null);
                        if (e.target.value) act.mutate({ id: r.id, attachmentId: e.target.value });
                      }}
                    >
                      <option value="">—</option>
                      {attachments.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.fileName}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <button
                  type="button"
                  className="link"
                  disabled={act.isPending}
                  onClick={() => {
                    setError(null);
                    act.mutate({ id: r.id });
                  }}
                >
                  Annulla la richiesta
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {canManage && !asking && (
        <button type="button" className="secondary" onClick={() => setAsking(true)}>
          Chiedi un documento
        </button>
      )}
      {canManage && asking && (
        <form className="form" onSubmit={submit} aria-label="Chiedi un documento">
          {expected.length > 0 && (
            <>
              <label htmlFor="request-expected">Documento</label>
              <select
                id="request-expected"
                value={expectedKey}
                onChange={(e) => setExpectedKey(e.target.value)}
              >
                <option value="">Altro documento</option>
                {expected.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </>
          )}
          <label htmlFor="request-message">Cosa serve</label>
          <textarea
            id="request-message"
            value={message}
            maxLength={1000}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Es. il fascicolo aggiornato al 2026, tutte le pagine"
          />
          <label htmlFor="request-due">Entro il (facoltativo)</label>
          <input
            id="request-due"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
          <p className="muted">
            La persona della pratica la riceve in chat e risponde inviando il file.
          </p>
          <div className="actions">
            <button type="submit" disabled={message.trim().length < 3 || ask.isPending}>
              Invia la richiesta
            </button>
            <button type="button" className="link" onClick={() => setAsking(false)}>
              Annulla
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
