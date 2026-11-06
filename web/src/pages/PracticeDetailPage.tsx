import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';

import { ApiError, describeError, type Me } from '../api/client';
import { type CurrentModule, shownFields } from '../api/modules';
import {
  formatDate,
  formatSize,
  kindLabel,
  OCR_LABELS,
  confirmedFields,
  readFields,
  STATE_LABELS,
  TRANSITION_LABELS,
  usefulSummary,
  type Attachment,
  type PracticeDetail,
  type PracticeState,
} from '../api/practices';
import { VALIDATION_FIELDS, type DocumentType } from '../api/review';
import { ValidationForm } from '../components/ValidationForm';
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
  // A02/A05: the module says the steps and the documents of this kind of practice.
  const moduleQuery = useQuery({
    queryKey: ['module'],
    queryFn: () => api<CurrentModule>('/modules/current'),
    retry: false,
  });
  const subState = useMutation({
    mutationFn: (value: string | null) =>
      api(`/practices/${id}/sub-state`, { method: 'POST', body: { subState: value } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['practice', id] });
    },
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
  const type = moduleQuery.data?.practiceTypes.find((t) => t.kind === p.kind);
  const steps = type?.subStates.filter((s) => s.during.includes(p.status)) ?? [];
  const currentStep = type?.subStates.find((s) => s.key === p.subState);
  const fields = type ? shownFields(type, p.fields) : [];
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
        {/* Who may move the practice may also set its step (same permission). */}
        {p.allowedTransitions.length > 0 && steps.length > 0 && (
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

      {type && type.expectedDocuments.length > 0 && (
        <section className="card" aria-labelledby="expected-title">
          <h2 id="expected-title">Documenti di solito necessari</h2>
          <ul className="plain">
            {type.expectedDocuments.map((d) => (
              <li key={d.key}>
                {d.label}
                {d.required ? '' : <span className="muted"> (se c’è)</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

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
  const [verifying, setVerifying] = useState(false);
  const read = readFields(attachment.ocrResult);
  const confirmed = attachment.validatedData ? confirmedFields(attachment.validatedData) : null;
  const known = readValues(attachment);

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
      {confirmed && (
        <details open>
          <summary>
            Dati confermati{confirmed.documentType ? `: ${confirmed.documentType}` : ''}{' '}
            <span className="state state-completed">confermati</span>
          </summary>
          <dl className="facts">
            {confirmed.fields.map((f) => (
              <div key={f.label} className="fact">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {!confirmed && (read.documentType || read.fields.length > 0) && (
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
      {(attachment.ocrStatus === 'COMPLETED' || attachment.ocrStatus === 'FAILED') && (
        <button type="button" className="link" onClick={() => setVerifying((v) => !v)}>
          {verifying ? 'Chiudi' : confirmed ? 'Correggi i dati' : 'Verifica i dati'}
        </button>
      )}
      {verifying && (
        <ValidationForm
          practiceId={practiceId}
          attachmentId={attachment.id}
          documentType={known.documentType}
          known={known.fields}
          onDone={() => setVerifying(false)}
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** What the form starts from: the confirmed data, otherwise the read ones. */
function readValues(attachment: Attachment): {
  documentType: DocumentType | null;
  fields: Record<string, string | number | null>;
} {
  if (attachment.validatedData) {
    return {
      documentType: attachment.validatedData.documentType as DocumentType,
      fields: attachment.validatedData.fields,
    };
  }
  const result = attachment.ocrResult ?? {};
  const type = typeof result.documentType === 'string' ? result.documentType : null;
  const documentType = type && type in VALIDATION_FIELDS ? (type as DocumentType) : null;
  const fields: Record<string, string | number | null> = {};
  for (const { key } of documentType ? VALIDATION_FIELDS[documentType] : []) {
    const value = result[key];
    fields[key] = typeof value === 'string' || typeof value === 'number' ? value : null;
  }
  return { documentType, fields };
}

function UploadForm({ practiceId }: { practiceId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [hint, setHint] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const upload = useMutation({
    // AGX-01: a file already sent is refused until the person chooses «Carica comunque».
    mutationFn: ({ file, allowDuplicate }: { file: File; allowDuplicate: boolean }) => {
      const form = new FormData();
      // The hint goes before the file: the backend reads the fields in order.
      if (hint.trim()) form.append('hint', hint.trim());
      form.append('file', file);
      const query = allowDuplicate ? '?allowDuplicate=true' : '';
      return api(`/practices/${practiceId}/attachments${query}`, { method: 'POST', form });
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
    if (file) upload.mutate({ file, allowDuplicate: false });
  };
  const duplicate =
    upload.error instanceof ApiError && upload.error.code === 'DUPLICATE_ATTACHMENT'
      ? upload.error.message
      : null;

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
      {duplicate && file && (
        <div className="notice" role="alert">
          <p>{duplicate} Vuoi caricarlo di nuovo?</p>
          <button
            type="button"
            onClick={() => upload.mutate({ file, allowDuplicate: true })}
            disabled={upload.isPending}
          >
            Carica comunque
          </button>
        </div>
      )}
      {upload.isError && !duplicate && (
        <p className="error" role="alert">
          {describeError(upload.error)}
        </p>
      )}
      {upload.isSuccess && <p role="status">Documento caricato.</p>}
    </form>
  );
}
