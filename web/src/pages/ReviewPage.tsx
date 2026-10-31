import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';

import { describeError, type Me } from '../api/client';
import { formatDateTime } from '../api/organization';
import { confirmedFields, DOCUMENT_TYPE_LABELS, FIELD_LABELS } from '../api/practices';
import {
  reviewQuery,
  type ReviewItem,
  type ReviewPage as Page,
  type ReviewStatus,
} from '../api/review';
import { ValidationForm } from '../components/ValidationForm';
import { useSession } from '../session/session';

/**
 * A1: the documents waiting for a person (read with doubts, or not read at all) and the ones
 * already confirmed. A collaborator sees their own; administrators and operators the organization.
 */
export function ReviewPage({ me }: { me: Me }) {
  const { api } = useSession();
  const [status, setStatus] = useState<ReviewStatus>('to_review');
  const [page, setPage] = useState(1);
  const [done, setDone] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['review', me.current.orgId, status, page],
    queryFn: () => api<Page>(reviewQuery(status, page)),
    placeholderData: keepPreviousData,
  });
  const data = query.data;

  const show = (next: ReviewStatus) => {
    setStatus(next);
    setPage(1);
    setDone(null);
  };

  return (
    <>
      <h1>Documenti da verificare</h1>
      <nav className="tabs" aria-label="Stato dei documenti">
        <button
          type="button"
          className={`link ${status === 'to_review' ? 'active' : ''}`}
          aria-pressed={status === 'to_review'}
          onClick={() => show('to_review')}
        >
          Da verificare{data && status === 'to_review' ? ` (${data.total})` : ''}
        </button>
        <button
          type="button"
          className={`link ${status === 'validated' ? 'active' : ''}`}
          aria-pressed={status === 'validated'}
          onClick={() => show('validated')}
        >
          Confermati
        </button>
      </nav>
      {done && (
        <p className="notice" role="status">
          {done}
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
          {status === 'to_review'
            ? 'Nessun documento da verificare.'
            : 'Nessun documento confermato.'}
        </p>
      )}
      {data && data.items.length > 0 && (
        <ul className="review-list">
          {data.items.map((item) =>
            status === 'to_review' ? (
              <ReviewCard
                key={item.attachmentId}
                item={item}
                onDone={(outcome) =>
                  setDone(
                    `${item.fileName}: dati ${outcome === 'confirmed' ? 'confermati' : 'corretti e confermati'}.`,
                  )
                }
              />
            ) : (
              <ConfirmedCard key={item.attachmentId} item={item} />
            ),
          )}
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
            Successivi
          </button>
        </nav>
      )}
      <p className="muted">
        I dati confermati diventano quelli ufficiali della pratica; quelli letti automaticamente
        restano conservati com&apos;erano.
      </p>
    </>
  );
}

function DocumentHead({ item }: { item: ReviewItem }) {
  const { download } = useSession();
  const [error, setError] = useState<string | null>(null);

  // Saved as a file, never opened in the page (§6 of the frontend plan).
  const save = async () => {
    setError(null);
    try {
      const { blob, fileName } = await download(
        `/practices/${item.practiceId}/attachments/${item.attachmentId}/download`,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setError(describeError(err));
    }
  };

  return (
    <>
      <div className="attachment-head">
        <span>
          <strong>{item.fileName}</strong>
          <span className="muted">
            {' '}
            · <Link to={`/pratiche/${item.practiceId}`}>{item.practiceName}</Link> ·{' '}
            {formatDateTime(item.createdAt)}
          </span>
        </span>
        <button type="button" className="secondary" onClick={() => void save()}>
          Scarica
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function ReviewCard({
  item,
  onDone,
}: {
  item: ReviewItem;
  onDone: (outcome: 'confirmed' | 'corrected') => void;
}) {
  const missing = item.missingFields.map((f) => FIELD_LABELS[f] ?? f);
  return (
    <li className="card">
      <DocumentHead item={item} />
      <p>
        {item.ocrStatus === 'FAILED' ? (
          <span className="badge warn">non letto: inserisci i dati a mano</span>
        ) : (
          <>
            Letto come{' '}
            <strong>
              {item.read.documentType
                ? (DOCUMENT_TYPE_LABELS[item.read.documentType] ?? item.read.documentType)
                : 'documento'}
            </strong>{' '}
            <span className="badge warn">da verificare</span>
          </>
        )}
      </p>
      {missing.length > 0 && <p className="muted">Non letti: {missing.join(', ')}.</p>}
      {item.warnings.length > 0 && (
        <ul className="warnings">
          {item.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <ValidationForm
        practiceId={item.practiceId}
        attachmentId={item.attachmentId}
        documentType={item.read.documentType}
        known={item.read.fields}
        onDone={onDone}
      />
    </li>
  );
}

function ConfirmedCard({ item }: { item: ReviewItem }) {
  if (!item.validated) return null;
  const shown = confirmedFields(item.validated.data);
  return (
    <li className="card">
      <DocumentHead item={item} />
      <p>
        <strong>{shown.documentType}</strong>{' '}
        <span className="state state-completed">confermato</span>{' '}
        <span className="muted">
          il {formatDateTime(item.validated.at)}
          {item.validated.byEmail ? ` da ${item.validated.byEmail}` : ''}
        </span>
      </p>
      <dl className="facts">
        {shown.fields.map((f) => (
          <div key={f.label} className="fact">
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}
