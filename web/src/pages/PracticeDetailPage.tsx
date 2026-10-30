import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';

import { describeError, type Me } from '../api/client';
import {
  formatDate,
  formatSize,
  kindLabel,
  OCR_LABELS,
  readFields,
  STATE_LABELS,
  TRANSITION_LABELS,
  usefulSummary,
  type Attachment,
  type PracticeDetail,
  type PracticeState,
} from '../api/practices';
import { useSession } from '../session/session';

/** P4: one practice, its allowed state changes and its attachments. */
export function PracticeDetailPage({ me }: { me: Me }) {
  const { id = '' } = useParams();
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<PracticeState | null>(null);

  const practice = useQuery({
    queryKey: ['practice', id],
    queryFn: () => api<PracticeDetail>(`/practices/${id}`),
  });
  const attachments = useQuery({
    queryKey: ['attachments', id],
    queryFn: () => api<Attachment[]>(`/practices/${id}/attachments`),
    enabled: practice.isSuccess,
  });

  const transition = useMutation({
    mutationFn: (nextState: PracticeState) =>
      api(`/practices/${id}/transition`, { method: 'POST', body: { nextState } }),
    onSuccess: async () => {
      setConfirm(null);
      await queryClient.invalidateQueries({ queryKey: ['practice', id] });
      await queryClient.invalidateQueries({ queryKey: ['practices'] });
    },
  });

  if (practice.isPending) return <p className="muted">Caricamento…</p>;
  if (practice.isError) {
    return (
      <>
        <p>
          <Link to="/pratiche">← Pratiche</Link>
        </p>
        <p className="error" role="alert">
          {describeError(practice.error)}
        </p>
      </>
    );
  }

  const p = practice.data;
  // Attachments are added only to one's own practices (attachment.create is "own" for everyone).
  const canUpload = p.userId === me.userId;
  return (
    <>
      <p>
        <Link to="/pratiche">← Pratiche</Link>
      </p>
      <div className="page-head">
        <h1>{p.name}</h1>
        <span className={`state state-${p.status.toLowerCase()}`}>{STATE_LABELS[p.status]}</span>
      </div>
      <section className="card">
        <dl className="facts">
          <dt>Tipo</dt>
          <dd>{kindLabel(p)}</dd>
          {usefulSummary(p) && (
            <>
              <dt>Riepilogo</dt>
              <dd>{usefulSummary(p)}</dd>
            </>
          )}
          <dt>Creata</dt>
          <dd>{formatDate(p.createdAt)}</dd>
          <dt>Aggiornata</dt>
          <dd>{formatDate(p.updatedAt)}</dd>
        </dl>
        {p.allowedTransitions.length > 0 && (
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
              p.allowedTransitions.map((s) => (
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
      </section>

      <section className="card" aria-labelledby="attachments-title">
        <h2 id="attachments-title">Allegati</h2>
        {attachments.isError && (
          <p className="error" role="alert">
            {describeError(attachments.error)}
          </p>
        )}
        {attachments.data && attachments.data.length === 0 && (
          <p className="muted">Nessun allegato.</p>
        )}
        <ul className="attachments">
          {attachments.data?.map((a) => (
            <AttachmentItem key={a.id} practiceId={id} attachment={a} />
          ))}
        </ul>
        {canUpload && <UploadForm practiceId={id} />}
      </section>
    </>
  );
}

function AttachmentItem({
  practiceId,
  attachment,
}: {
  practiceId: string;
  attachment: Attachment;
}) {
  const { download } = useSession();
  const [error, setError] = useState<string | null>(null);
  const read = readFields(attachment.ocrResult);

  // Saved as a file, never opened in the page (§6 of the frontend plan).
  const save = async () => {
    setError(null);
    try {
      const { blob, fileName } = await download(
        `/practices/${practiceId}/attachments/${attachment.id}/download`,
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
    <li>
      <div className="attachment-head">
        <span>
          <strong>{attachment.fileName}</strong>{' '}
          <span className="muted">
            {formatSize(attachment.fileSize)} · {formatDate(attachment.createdAt)} ·{' '}
            {OCR_LABELS[attachment.ocrStatus]}
          </span>
        </span>
        <button type="button" className="secondary" onClick={() => void save()}>
          Scarica
        </button>
      </div>
      {(read.documentType || read.fields.length > 0) && (
        <details>
          <summary>
            Dati letti{read.documentType ? `: ${read.documentType}` : ''}
            {read.reviewRequired && <span className="badge warn">da verificare</span>}
          </summary>
          <dl className="facts">
            {read.fields.map((f) => (
              <div key={f.label} className="fact">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
          {read.warnings.length > 0 && (
            <ul className="warnings">
              {read.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </details>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function UploadForm({ practiceId }: { practiceId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [hint, setHint] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      // The hint goes before the file: the backend reads the fields in order.
      if (hint.trim()) form.append('hint', hint.trim());
      form.append('file', file);
      return api(`/practices/${practiceId}/attachments`, { method: 'POST', form });
    },
    onSuccess: async () => {
      setHint('');
      setFile(null);
      if (input.current) input.current.value = '';
      await queryClient.invalidateQueries({ queryKey: ['attachments', practiceId] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (file) upload.mutate(file);
  };

  return (
    <form className="upload" onSubmit={submit}>
      <h3>Aggiungi un documento</h3>
      <label htmlFor="file">File (PDF o immagine)</label>
      <input
        id="file"
        ref={input}
        type="file"
        accept="application/pdf,image/*"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <label htmlFor="hint">Che documento è? (facoltativo)</label>
      <input
        id="hint"
        value={hint}
        maxLength={200}
        onChange={(e) => setHint(e.target.value)}
        placeholder="Es. fattura, DDT, ricevuta"
      />
      <button type="submit" disabled={!file || upload.isPending}>
        {upload.isPending ? 'Caricamento e lettura…' : 'Carica'}
      </button>
      {upload.isError && (
        <p className="error" role="alert">
          {describeError(upload.error)}
        </p>
      )}
      {upload.isSuccess && <p role="status">Documento caricato.</p>}
    </form>
  );
}
