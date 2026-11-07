import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { describeError } from '../api/client';
import { DOCUMENT_TYPE_LABELS, FIELD_LABELS } from '../api/practices';
import {
  CERTIFICATE_CATEGORY_LABELS,
  DOCUMENT_TYPES,
  startingValues,
  toPayload,
  VALIDATION_FIELDS,
  type DocumentType,
} from '../api/review';
import { useSession } from '../session/session';

/**
 * A1: confirms or corrects the data read from a document, including its type. Starts from the
 * confirmed data when present, otherwise from what was read. Confirming unchanged data is fine:
 * the person states they are right.
 */
export function ValidationForm({
  practiceId,
  attachmentId,
  documentType,
  known,
  onDone,
  basePath,
  refreshKey,
}: {
  practiceId: string;
  /** AGX-04: where the practice is reached; through a delegation it is under `/grants/:id`. */
  basePath?: string;
  /** AGX-04: the query to refresh after saving, when not the practice's own attachments. */
  refreshKey?: readonly unknown[];
  attachmentId: string;
  documentType: DocumentType | null;
  known: Record<string, string | number | null>;
  onDone?: (outcome: 'confirmed' | 'corrected') => void;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [type, setType] = useState<DocumentType>(documentType ?? 'receipt');
  const [values, setValues] = useState(() => startingValues(documentType ?? 'receipt', known));
  const id = (key: string) => `v-${attachmentId}-${key}`;

  const save = useMutation({
    mutationFn: () =>
      api<{ outcome: 'confirmed' | 'corrected' }>(
        `${basePath ?? `/practices/${practiceId}`}/attachments/${attachmentId}/validation`,
        { method: 'POST', body: { documentType: type, fields: toPayload(type, values) } },
      ),
    onSuccess: async (data) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['review'] }),
        queryClient.invalidateQueries({ queryKey: refreshKey ?? ['attachments', practiceId] }),
        queryClient.invalidateQueries({ queryKey: ['summary'] }),
        // AGX-05: a confirmed file makes its expected document valid.
        queryClient.invalidateQueries({ queryKey: ['checklist', practiceId] }),
      ]);
      onDone?.(data.outcome);
    },
  });

  const changeType = (next: DocumentType) => {
    setType(next);
    // Fields with the same name keep their value (e.g. the date from a receipt to an invoice).
    setValues((current) => startingValues(next, { ...known, ...current }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <form className="validation" onSubmit={submit} aria-label="Verifica dei dati del documento">
      <label htmlFor={id('type')}>Tipo di documento</label>
      <select
        id={id('type')}
        value={type}
        onChange={(e) => changeType(e.target.value as DocumentType)}
      >
        {DOCUMENT_TYPES.map((t) => (
          <option key={t} value={t}>
            {DOCUMENT_TYPE_LABELS[t] ?? t}
          </option>
        ))}
      </select>
      {VALIDATION_FIELDS[type].map(({ key, kind }) => (
        <div key={key}>
          <label htmlFor={id(key)}>{FIELD_LABELS[key] ?? key}</label>
          {kind === 'category' ? (
            <select
              id={id(key)}
              value={values[key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
            >
              <option value="">—</option>
              {Object.entries(CERTIFICATE_CATEGORY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={id(key)}
              type={kind === 'date' ? 'date' : 'text'}
              inputMode={kind === 'amount' || kind === 'percent' ? 'decimal' : undefined}
              maxLength={200}
              value={values[key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
            />
          )}
        </div>
      ))}
      <button type="submit" disabled={save.isPending}>
        Conferma i dati
      </button>
      {save.isError && (
        <p className="error" role="alert">
          {describeError(save.error)}
        </p>
      )}
    </form>
  );
}
