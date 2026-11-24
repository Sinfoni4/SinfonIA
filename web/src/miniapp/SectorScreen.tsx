import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useParams } from 'react-router';

import { describeError, miniAppSectorFeatures, type Me } from '../api/client';
import {
  dataToForm,
  formToData,
  missingRequired,
  sectorPath,
  sectorRecordsQuery,
  type SectorRecord,
  type SectorRecordKind,
  type SectorRegisterPage,
  fileSizeLabel,
  sectorFilePath,
  NOTIFY_KEY,
  type SectorPerson,
} from '../api/sector';
import { useSession } from '../session/session';

import { BackIcon, DocIcon, PlusIcon } from './icons';

type View = { mode: 'list' } | { mode: 'new' } | { mode: 'edit'; record: SectorRecord };

/** dd/mm from an ISO date, for the short lines of the list. */
const shortDate = (iso: string) => iso.slice(0, 10).split('-').reverse().slice(0, 2).join('/');

function whenLabel(record: SectorRecord): string {
  if (record.dueDate && record.daysLeft !== null) {
    if (record.daysLeft < 0) return 'scaduta';
    if (record.daysLeft === 0) return 'scade oggi';
    if (record.daysLeft <= 60) return `tra ${record.daysLeft} gg`;
    return `scade ${shortDate(record.dueDate)}`;
  }
  return record.occurredOn ? shortDate(record.occurredOn) : '';
}

/**
 * A function of the sector in the Mini App: a function still being built says so; a built one is
 * its register, short, with a quick entry from the phone (e.g. a treatment just done in the field).
 */
export function SectorScreen({ me }: { me: Me }) {
  const { featureId } = useParams();
  const feature = miniAppSectorFeatures(me).find((f) => f.id === featureId);
  if (!feature) return <Navigate to="/tg" replace />;
  if (feature.ready)
    return <SectorRegisterScreen key={feature.id} me={me} featureId={feature.id} />;
  return (
    <>
      <Head title={feature.label} />
      <section className="ma-list" aria-label={feature.label}>
        <p>{feature.description}</p>
        <p className="ma-muted">
          In preparazione: la tua organizzazione l’ha attivata e comparirà qui appena pronta.
        </p>
      </section>
    </>
  );
}

function Head({
  title,
  onBack,
  action,
}: {
  title: string;
  onBack?: () => void;
  action?: React.ReactNode;
}) {
  return (
    <header className="ma-panel-head">
      {onBack ? (
        <button type="button" className="ma-iconbtn" aria-label="Torna all’elenco" onClick={onBack}>
          <BackIcon />
        </button>
      ) : (
        <Link to="/tg" className="ma-iconbtn" aria-label="Torna a Oggi">
          <BackIcon />
        </Link>
      )}
      <h1>{title}</h1>
      {action ?? <span style={{ width: 44 }} aria-hidden="true" />}
    </header>
  );
}

function SectorRegisterScreen({ me, featureId }: { me: Me; featureId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>({ mode: 'list' });
  const key = ['miniapp', 'sector', me.current.orgId, featureId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<SectorRegisterPage>(sectorRecordsQuery('miniapp', featureId, { limit: 30 })),
  });
  const register = query.data;
  const label =
    register?.feature.label ?? miniAppSectorFeatures(me).find((f) => f.id === featureId)?.label;
  const back = () => setView({ mode: 'list' });
  const saved = async () => {
    back();
    await queryClient.invalidateQueries({ queryKey: key });
  };

  if (register && view.mode !== 'list') {
    return (
      <>
        <Head title={view.mode === 'new' ? 'Nuova voce' : view.record.kindLabel} onBack={back} />
        <section className="ma-list">
          <EntryForm
            featureId={featureId}
            kinds={register.kinds}
            people={register.people}
            record={view.mode === 'edit' ? view.record : undefined}
            canManage={register.canManage}
            onDone={saved}
          />
          {view.mode === 'edit' && (
            <EntryFiles
              featureId={featureId}
              record={view.record}
              canManage={register.canManage}
              onChange={async (record) => {
                setView({ mode: 'edit', record });
                await queryClient.invalidateQueries({ queryKey: key });
              }}
            />
          )}
        </section>
      </>
    );
  }

  return (
    <>
      <Head
        title={label ?? 'Registro'}
        action={
          register?.canManage ? (
            <button
              type="button"
              className="ma-iconbtn"
              aria-label="Nuova voce"
              onClick={() => setView({ mode: 'new' })}
            >
              <PlusIcon />
            </button>
          ) : undefined
        }
      />
      {query.isError && (
        <p className="ma-message error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="ma-muted">Caricamento…</p>}
      {register && (
        <section className="ma-list" aria-label={register.feature.label}>
          {register.items.map((r) => (
            <button
              key={r.id}
              type="button"
              className="ma-row"
              onClick={() => setView({ mode: 'edit', record: r })}
            >
              <DocIcon size={20} />
              <span className="ma-row-title">
                {r.title}
                <small className="ma-row-sub">{r.kindLabel}</small>
              </span>
              <span className={`ma-row-when${(r.daysLeft ?? 0) < 0 ? ' error' : ''}`}>
                {whenLabel(r)}
              </span>
            </button>
          ))}
          {register.items.length === 0 && (
            <p className="ma-muted">
              {register.canManage
                ? 'Nessuna voce: aggiungi la prima con +.'
                : 'Nessuna voce da mostrare.'}
            </p>
          )}
          {register.total > register.items.length && (
            <p className="ma-muted">
              Qui vedi le ultime {register.items.length} voci su {register.total}: l’elenco completo
              è nella dashboard.
            </p>
          )}
        </section>
      )}
    </>
  );
}

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });

function EntryForm({
  featureId,
  kinds,
  people,
  record,
  canManage,
  onDone,
}: {
  featureId: string;
  kinds: readonly SectorRecordKind[];
  people: readonly SectorPerson[];
  record?: SectorRecord;
  canManage: boolean;
  onDone: () => Promise<void>;
}) {
  const { api } = useSession();
  const [kindId, setKindId] = useState(record?.kind ?? kinds[0]?.kind ?? '');
  const kind = kinds.find((k) => k.kind === kindId) ?? kinds[0];
  const initial = (k: SectorRecordKind) =>
    record ? dataToForm(k, record.data) : k.dateField ? { [k.dateField]: today() } : {};
  const [values, setValues] = useState<Record<string, string>>(() => initial(kind));
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const data = formToData(kind, values);
      return record
        ? api(sectorPath('miniapp', featureId, record.id), { method: 'PATCH', body: { data } })
        : api(sectorPath('miniapp', featureId), {
            method: 'POST',
            body: { kind: kind.kind, data },
          });
    },
    onSuccess: onDone,
  });
  const remove = useMutation({
    mutationFn: () => api(sectorPath('miniapp', featureId, record!.id), { method: 'DELETE' }),
    onSuccess: onDone,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missing = missingRequired(kind, values);
    if (missing) {
      setProblem(`Compila «${missing.label}».`);
      return;
    }
    setProblem(null);
    save.mutate();
  };

  return (
    <form className="ma-form" onSubmit={submit}>
      {!record && kinds.length > 1 && (
        <label>
          Tipo di voce
          <select
            value={kindId}
            onChange={(e) => {
              const next = kinds.find((k) => k.kind === e.target.value) ?? kind;
              setKindId(next.kind);
              setValues(initial(next));
            }}
          >
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind.fields.map((field) => {
        const value = values[field.key] ?? '';
        const set = (v: string) => setValues((old) => ({ ...old, [field.key]: v }));
        const label = `${field.label}${field.required ? ' *' : ''}`;
        return (
          <label key={field.key}>
            {label}
            {field.type === 'choice' ? (
              <select value={value} disabled={!canManage} onChange={(e) => set(e.target.value)}>
                <option value="">—</option>
                {(field.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : field.key === 'notes' ? (
              <textarea
                value={value}
                maxLength={field.maxLength}
                readOnly={!canManage}
                onChange={(e) => set(e.target.value)}
              />
            ) : (
              <input
                type={field.type === 'date' ? 'date' : 'text'}
                inputMode={field.type === 'number' ? 'decimal' : undefined}
                maxLength={field.type === 'text' ? field.maxLength : undefined}
                value={value}
                readOnly={!canManage}
                onChange={(e) => set(e.target.value)}
              />
            )}
          </label>
        );
      })}
      {kind.notify && people.length > 0 && (
        <label>
          {kind.notify}
          <select
            value={values[NOTIFY_KEY] ?? ''}
            disabled={!canManage}
            onChange={(e) => setValues((old) => ({ ...old, [NOTIFY_KEY]: e.target.value }))}
          >
            <option value="">Nessuna (solo gli amministratori)</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {(problem || save.isError || remove.isError) && (
        <p className="ma-message error" role="alert">
          {problem ?? describeError(save.error ?? remove.error)}
        </p>
      )}
      {canManage && (
        <button type="submit" className="ma-primary" disabled={save.isPending}>
          {save.isPending ? 'Salvataggio…' : 'Salva'}
        </button>
      )}
      {canManage &&
        record &&
        (confirmDelete ? (
          <div className="ma-actions-row">
            <button
              type="button"
              className="ma-primary danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Elimina davvero
            </button>
            <button type="button" className="ma-link" onClick={() => setConfirmDelete(false)}>
              Annulla
            </button>
          </div>
        ) : (
          <button type="button" className="ma-link" onClick={() => setConfirmDelete(true)}>
            Elimina questa voce
          </button>
        ))}
    </form>
  );
}

/**
 * The files of an entry in the Mini App: what is attached, and a photo or a PDF to add (the
 * camera opens on the phone). Downloading is in the dashboard.
 */
function EntryFiles({
  featureId,
  record,
  canManage,
  onChange,
}: {
  featureId: string;
  record: SectorRecord;
  canManage: boolean;
  onChange: (record: SectorRecord) => Promise<void>;
}) {
  const { api } = useSession();
  const [inputKey, setInputKey] = useState(0);
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api<SectorRecord>(sectorFilePath('miniapp', featureId, record.id), {
        method: 'POST',
        form,
      });
    },
    onSuccess: async (updated) => {
      setInputKey((k) => k + 1);
      await onChange(updated);
    },
  });
  return (
    <div className="ma-form" aria-label="File allegati">
      <h2>File allegati</h2>
      {record.attachments.length === 0 ? (
        <p className="ma-muted">Nessun file.</p>
      ) : (
        record.attachments.map((a) => (
          <p key={a.id} className="ma-message">
            📎 {a.fileName} · {fileSizeLabel(a.fileSize)}
          </p>
        ))
      )}
      {canManage && (
        <label>
          {upload.isPending ? 'Caricamento…' : 'Aggiungi una foto o un PDF'}
          <input
            key={inputKey}
            type="file"
            accept="image/*,application/pdf"
            disabled={upload.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
            }}
          />
        </label>
      )}
      {upload.isError && (
        <p className="ma-message error" role="alert">
          {describeError(upload.error)}
        </p>
      )}
    </div>
  );
}
