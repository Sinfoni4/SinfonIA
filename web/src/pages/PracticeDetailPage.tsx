import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';

import { ApiError, describeError, type Me } from '../api/client';
import { type CurrentModule, shownFields } from '../api/modules';
import {
  formatDate,
  formatSize,
  holderLabel,
  isMine,
  kindLabel,
  OCR_LABELS,
  confirmedFields,
  readFields,
  STATE_LABELS,
  TRANSITION_LABELS,
  usefulSummary,
  type Attachment,
  type DocumentChecklist as Checklist,
  type ExpectedDocument,
  type HolderCandidate,
  type PracticeDetail,
  type PracticeState,
} from '../api/practices';
import { VALIDATION_FIELDS, type DocumentType } from '../api/review';
import { DocumentChecklist } from '../components/DocumentChecklist';
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
  // AGX-03: who may assign practices also chooses the holder; refused otherwise (then hidden).
  const holders = useQuery({
    queryKey: ['holders', me.current.orgId],
    queryFn: () => api<HolderCandidate[]>('/practices/holders'),
    enabled: me.current.role !== 'MEMBER',
    retry: false,
  });
  const setHolder = useMutation({
    mutationFn: (userId: string | null) =>
      api(`/practices/${id}/holder`, { method: 'POST', body: { userId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['practice', id] });
      await queryClient.invalidateQueries({ queryKey: ['practices'] });
    },
  });
  // AGX-05: computed by the backend; an older backend has none, then the plain list is shown.
  const checklist = useQuery({
    queryKey: ['checklist', id],
    queryFn: () => api<Checklist>(`/practices/${id}/checklist`),
    enabled: practice.isSuccess,
    retry: false,
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
  // Attachments are added only to one's own practices (attachment.create is "own" for everyone):
  // created by the person or opened for them (AGX-03).
  const canUpload = isMine(p, me.userId);
  const holderUserId = p.holderUserId ?? null;
  const holderName =
    holderUserId === me.userId
      ? 'tu'
      : (() => {
          const found = holders.data?.find((c) => c.userId === holderUserId);
          return found ? holderLabel(found) : 'un’altra persona';
        })();
  const holderChoices = (holders.data ?? []).filter((c) => c.userId !== p.userId);
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
          {holderUserId && (
            <>
              <dt>Aperta per</dt>
              <dd>{holderName}</dd>
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
        {holders.isSuccess && holderChoices.length > 0 && (
          <div className="actions">
            <label htmlFor="holder">Aperta per</label>
            <select
              id="holder"
              value={holderUserId ?? ''}
              disabled={setHolder.isPending}
              onChange={(e) => setHolder.mutate(e.target.value || null)}
            >
              <option value="">Chi l’ha aperta</option>
              {holderUserId && !holderChoices.some((c) => c.userId === holderUserId) && (
                <option value={holderUserId}>persona non più attiva</option>
              )}
              {holderChoices.map((c) => (
                <option key={c.userId} value={c.userId}>
                  {holderLabel(c)}
                </option>
              ))}
            </select>
          </div>
        )}
        {setHolder.isError && (
          <p className="error" role="alert">
            {describeError(setHolder.error)}
          </p>
        )}
      </section>

      {checklist.data && <DocumentChecklist checklist={checklist.data} />}
      {!checklist.data && type && type.expectedDocuments.length > 0 && (
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
            <AttachmentItem
              key={a.id}
              practiceId={id}
              attachment={a}
              expected={type?.expectedDocuments ?? []}
              // The backend refuses it to anyone who does not check the whole organization.
              canReject={me.current.role !== 'MEMBER'}
            />
          ))}
        </ul>
        {canUpload && <UploadForm practiceId={id} expected={type?.expectedDocuments ?? []} />}
      </section>
    </>
  );
}

/**
 * One document of a practice: download, data read or confirmed, and their check. AGX-04: also
 * used through a delegation, with its own base path, and without the check when not allowed.
 */
export function AttachmentItem({
  practiceId,
  attachment,
  basePath,
  refreshKey,
  canValidate = true,
  expected = [],
  canReject = false,
}: {
  practiceId: string;
  attachment: Attachment;
  basePath?: string;
  refreshKey?: readonly unknown[];
  canValidate?: boolean;
  /** AGX-05: the documents the practice's type expects, to say which one this file is. */
  expected?: readonly ExpectedDocument[];
  /** AGX-05: whether to offer the rejection (the backend still decides). */
  canReject?: boolean;
}) {
  const base = basePath ?? `/practices/${practiceId}`;
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: refreshKey ?? ['attachments', practiceId] });
    await queryClient.invalidateQueries({ queryKey: ['checklist', practiceId] });
  };
  const link = useMutation({
    mutationFn: (expectedKey: string | null) =>
      api(`${base}/attachments/${attachment.id}/expected`, {
        method: 'POST',
        body: { expectedKey },
      }),
    onSuccess: refresh,
    onError: (err: unknown) => setError(describeError(err)),
  });
  const reject = useMutation({
    mutationFn: () =>
      api(`${base}/attachments/${attachment.id}/rejection`, {
        method: 'POST',
        body: { reason: reason.trim() },
      }),
    onSuccess: async () => {
      setRejecting(false);
      setReason('');
      await refresh();
    },
    onError: (err: unknown) => setError(describeError(err)),
  });
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
      const { blob, fileName } = await download(`${base}/attachments/${attachment.id}/download`);
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
          {attachment.rejectedAt && <span className="state state-failed">respinto</span>}
        </span>
        <button type="button" className="secondary" onClick={() => void save()}>
          Scarica
        </button>
      </div>
      {attachment.rejectedAt && attachment.rejectionReason && (
        <p className="error">Motivo del rifiuto: {attachment.rejectionReason}</p>
      )}
      {canValidate && expected.length > 0 && (
        <div className="actions">
          <label htmlFor={`expected-${attachment.id}`}>Documento previsto</label>
          <select
            id={`expected-${attachment.id}`}
            value={attachment.expectedKey ?? ''}
            disabled={link.isPending}
            onChange={(e) => {
              setError(null);
              link.mutate(e.target.value || null);
            }}
          >
            <option value="">Nessuno</option>
            {expected.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      )}
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
      {canValidate &&
        (attachment.ocrStatus === 'COMPLETED' || attachment.ocrStatus === 'FAILED') && (
          <button type="button" className="link" onClick={() => setVerifying((v) => !v)}>
            {verifying ? 'Chiudi' : confirmed ? 'Correggi i dati' : 'Verifica i dati'}
          </button>
        )}
      {canReject && !attachment.rejectedAt && !rejecting && (
        <button type="button" className="link" onClick={() => setRejecting(true)}>
          Rifiuta
        </button>
      )}
      {rejecting && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            reject.mutate();
          }}
        >
          <label htmlFor={`reason-${attachment.id}`}>Motivo del rifiuto</label>
          <textarea
            id={`reason-${attachment.id}`}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Es. documento scaduto, pagina mancante, illeggibile"
          />
          <p className="muted">La persona della pratica lo riceve in chat con il motivo.</p>
          <div className="actions">
            <button type="submit" disabled={reason.trim().length < 3 || reject.isPending}>
              Conferma rifiuto
            </button>
            <button type="button" className="link" onClick={() => setRejecting(false)}>
              Annulla
            </button>
          </div>
        </form>
      )}
      {verifying && (
        <ValidationForm
          practiceId={practiceId}
          attachmentId={attachment.id}
          documentType={known.documentType}
          known={known.fields}
          basePath={basePath}
          refreshKey={refreshKey}
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

/** Upload of a document. AGX-04: also through a delegation, with its own base path. */
export function UploadForm({
  practiceId,
  basePath,
  refreshKey,
  expected = [],
}: {
  practiceId: string;
  basePath?: string;
  refreshKey?: readonly unknown[];
  /** AGX-05: the documents the practice's type expects, to say which one the file is. */
  expected?: readonly ExpectedDocument[];
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [hint, setHint] = useState('');
  const [expectedKey, setExpectedKey] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const upload = useMutation({
    // AGX-01: a file already sent is refused until the person chooses «Carica comunque».
    mutationFn: ({ file, allowDuplicate }: { file: File; allowDuplicate: boolean }) => {
      const form = new FormData();
      // The hint goes before the file: the backend reads the fields in order.
      if (hint.trim()) form.append('hint', hint.trim());
      if (expectedKey) form.append('expectedKey', expectedKey);
      form.append('file', file);
      const query = allowDuplicate ? '?allowDuplicate=true' : '';
      return api(`${basePath ?? `/practices/${practiceId}`}/attachments${query}`, {
        method: 'POST',
        form,
      });
    },
    onSuccess: async () => {
      setHint('');
      setExpectedKey('');
      setFile(null);
      if (input.current) input.current.value = '';
      await queryClient.invalidateQueries({ queryKey: refreshKey ?? ['attachments', practiceId] });
      await queryClient.invalidateQueries({ queryKey: ['checklist', practiceId] });
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
      {expected.length > 0 && (
        <>
          <label htmlFor="expected-key">Quale documento previsto è? (facoltativo)</label>
          <select
            id="expected-key"
            value={expectedKey}
            onChange={(e) => setExpectedKey(e.target.value)}
          >
            <option value="">Nessuno di questi</option>
            {expected.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </>
      )}
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
