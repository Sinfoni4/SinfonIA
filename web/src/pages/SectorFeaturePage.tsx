import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate, useParams } from 'react-router';

import { dashboardSectorFeatures, describeError, type Me } from '../api/client';
import { daysLabel, isoToItalian } from '../api/compliance';
import {
  dataToForm,
  fieldValueLabel,
  formToData,
  missingRequired,
  sectorPath,
  sectorRecordsQuery,
  type SectorField,
  type SectorFilters,
  type SectorRecord,
  type SectorRecordKind,
  type SectorRegisterPage,
  saveBlob,
  sectorExportPath,
  sectorFilePath,
  fileSizeLabel,
  type SectorExportFormat,
  NOTIFY_KEY,
  type SectorPerson,
  type SectorChannel,
  reasonProblem,
  sectorVersionsPath,
  sectorVoidPath,
  versionChanges,
  VERSION_ACTIONS,
  type SectorRecordState,
  type SectorRecordVersion,
} from '../api/sector';
import { DataTable, type DataColumn } from '../components/DataTable';
import { useSession } from '../session/session';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

/**
 * A function of the organization's sector turned on from the console. A built function is a
 * register (entries with the fields the server declares); one still being built says what it will
 * do; a function not on in the dashboard goes back home.
 */
export function SectorFeaturePage({ me }: { me: Me }) {
  const { featureId } = useParams();
  const feature = dashboardSectorFeatures(me).find((f) => f.id === featureId);
  if (!feature) return <Navigate to="/" replace />;
  if (feature.ready) return <SectorRegister key={feature.id} me={me} featureId={feature.id} />;
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-2xl font-semibold tracking-tight">{feature.label}</h1>
        <Badge variant="outline" className="px-1.5 text-muted-foreground">
          in preparazione
        </Badge>
      </div>
      <p className="m-0">{feature.description}</p>
      <p className="m-0 text-muted-foreground">
        Questa funzione è stata attivata per la tua organizzazione ed è in preparazione: comparirà
        qui, e nella Mini App di Telegram, appena sarà pronta.
      </p>
    </div>
  );
}

/**
 * MF8: a register of another organization through a delegation received, with the name of that
 * organization always in view and only the delegated operations offered.
 */
export function DelegatedRegisterPage({ me }: { me: Me }) {
  const { grantId = '', featureId = '' } = useParams();
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0">
        <Link to="/deleghe">← Deleghe</Link>
      </p>
      <SectorRegister
        key={`${grantId}:${featureId}`}
        me={me}
        featureId={featureId}
        channel={{ grantId }}
      />
    </div>
  );
}

type Editing = { mode: 'new'; kind: string } | { mode: 'edit'; record: SectorRecord } | null;

function SectorRegister({
  me,
  featureId,
  channel = 'dashboard',
}: {
  me: Me;
  featureId: string;
  channel?: SectorChannel;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<
    Required<Pick<SectorFilters, 'page' | 'limit'>> & SectorFilters
  >({ page: 1, limit: 20, kind: '', state: '', search: '', from: '', to: '' });
  const [editing, setEditing] = useState<Editing>(null);
  // Fase 1A: an entry is voided with a reason, never deleted; its history can always be read.
  const [voiding, setVoiding] = useState<SectorRecord | null>(null);
  const [history, setHistory] = useState<SectorRecord | null>(null);
  const key = [
    'sector',
    me.current.orgId,
    featureId,
    typeof channel === 'object' ? `grant:${channel.grantId}` : channel,
  ];

  const query = useQuery({
    queryKey: [...key, filters],
    queryFn: () => api<SectorRegisterPage>(sectorRecordsQuery(channel, featureId, filters)),
    placeholderData: keepPreviousData,
  });
  const register = query.data;
  const kinds = register?.kinds ?? [];
  // Through a delegation, only what it allows (voiding with its DELETE); files are never removed
  // there.
  const ops = register?.delegation?.operations;
  const can = {
    create: ops ? ops.includes('CREATE') : register?.canManage === true,
    edit: ops ? ops.includes('UPDATE') : register?.canManage === true,
    void: register?.canVoid === true,
    removeFile: ops ? false : register?.canManage === true,
    export: ops ? ops.includes('EXPORT') : true,
  };
  const open = (panel: 'edit' | 'void' | 'history', record: SectorRecord) => {
    setEditing(panel === 'edit' ? { mode: 'edit', record } : null);
    setVoiding(panel === 'void' ? record : null);
    setHistory(panel === 'history' ? record : null);
  };
  const hasExpiry = kinds.some((k) => k.dueField);
  const expiring = useQuery({
    queryKey: [...key, 'expiring'],
    queryFn: () =>
      api<SectorRegisterPage>(
        sectorRecordsQuery(channel, featureId, { expiringWithinDays: 60, limit: 5 }),
      ),
    enabled: hasExpiry,
  });

  const columns = useMemo<Array<DataColumn<SectorRecord>>>(
    () => [
      {
        id: 'date',
        header: 'Data',
        meta: { label: 'Data', className: 'whitespace-nowrap' },
        cell: ({ row }) => (row.original.occurredOn ? isoToItalian(row.original.occurredOn) : '—'),
      },
      {
        id: 'kind',
        header: 'Tipo',
        meta: { label: 'Tipo' },
        cell: ({ row }) => row.original.kindLabel,
      },
      {
        id: 'title',
        header: 'Voce',
        enableHiding: false,
        meta: { label: 'Voce' },
        cell: ({ row }) => <EntrySummary record={row.original} kinds={kinds} />,
      },
      ...(hasExpiry
        ? [
            {
              id: 'due',
              header: 'Scadenza',
              meta: { label: 'Scadenza', className: 'whitespace-nowrap' },
              cell: ({ row }: { row: { original: SectorRecord } }) =>
                row.original.dueDate ? (
                  <span>
                    {isoToItalian(row.original.dueDate)}
                    <br />
                    <span
                      className={
                        (row.original.daysLeft ?? 0) < 0
                          ? 'text-destructive'
                          : 'text-muted-foreground'
                      }
                    >
                      {daysLabel(row.original.daysLeft ?? 0)}
                    </span>
                  </span>
                ) : (
                  '—'
                ),
            } satisfies DataColumn<SectorRecord>,
          ]
        : []),
      {
        id: 'author',
        header: 'Inserita da',
        meta: { label: 'Inserita da' },
        cell: ({ row }) => row.original.author?.email ?? '—',
      },
      {
        id: 'actions',
        header: 'Azioni',
        enableHiding: false,
        meta: { label: 'Azioni', className: 'whitespace-nowrap' },
        cell: ({ row }) => {
          const record = row.original;
          return (
            <span className="flex gap-2">
              {can.edit && !record.voided && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Rettifica ${record.title}`}
                  onClick={() => open('edit', record)}
                >
                  Rettifica
                </Button>
              )}
              {can.void && !record.voided && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Annulla ${record.title}`}
                  onClick={() => open('void', record)}
                >
                  Annulla voce
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Storico di ${record.title}`}
                onClick={() => open('history', record)}
              >
                Storico
              </Button>
            </span>
          );
        },
      },
    ],
    // `open` only sets state: not a dependency.
    [hasExpiry, kinds, can.edit, can.void],
  );

  const set = (patch: Partial<SectorFilters>) => setFilters((f) => ({ ...f, page: 1, ...patch }));

  return (
    <div className="flex flex-col gap-4">
      {register?.delegation && (
        <p className="notice banner m-0" role="note">
          Stai lavorando sul registro di <strong>{register.delegation.grantorName}</strong> per
          delega, fino al {isoToItalian(register.delegation.validUntil.slice(0, 10))}. Ogni
          operazione resta nel suo registro attività.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-2xl font-semibold tracking-tight">
            {register?.feature.label ?? 'Registro'}
            {register?.delegation ? ` di ${register.delegation.grantorName}` : ''}
          </h1>
          {register && <p className="m-0 text-muted-foreground">{register.feature.description}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {register && register.total > 0 && can.export && (
            <ExportButtons channel={channel} featureId={featureId} filters={filters} />
          )}
          {can.create && kinds.length > 0 && (
            <Button type="button" onClick={() => setEditing({ mode: 'new', kind: kinds[0].kind })}>
              Nuova voce
            </Button>
          )}
        </div>
      </div>

      {query.isError && (
        <p className="error m-0" role="alert">
          {describeError(query.error)}
        </p>
      )}

      {editing && register && (
        <EntryForm
          channel={channel}
          featureId={featureId}
          kinds={kinds}
          people={register.people}
          editing={editing}
          onDone={async () => {
            setEditing(null);
            await queryClient.invalidateQueries({ queryKey: key });
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {voiding && (
        <VoidForm
          channel={channel}
          featureId={featureId}
          record={voiding}
          onDone={async () => {
            setVoiding(null);
            await queryClient.invalidateQueries({ queryKey: key });
          }}
          onCancel={() => setVoiding(null)}
        />
      )}
      {history && (
        <EntryHistory
          channel={channel}
          featureId={featureId}
          record={history}
          kind={kinds.find((k) => k.kind === history.kind)}
          onClose={() => setHistory(null)}
        />
      )}
      {editing?.mode === 'edit' && register && (
        <EntryFiles
          channel={channel}
          featureId={featureId}
          record={editing.record}
          canManage={can.edit}
          canRemove={can.removeFile}
          onChange={async (record) => {
            setEditing({ mode: 'edit', record });
            await queryClient.invalidateQueries({ queryKey: key });
          }}
        />
      )}

      {hasExpiry && expiring.data && expiring.data.total > 0 && (
        <section aria-labelledby="expiring" className="rounded-lg border p-4">
          <h2 id="expiring" className="m-0 mb-2 text-base font-semibold">
            In scadenza nei prossimi 60 giorni ({expiring.data.total})
          </h2>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {expiring.data.items.map((r) => (
              <li key={r.id}>
                <span className="font-medium">{r.title}</span> —{' '}
                {r.dueDate && isoToItalian(r.dueDate)}{' '}
                <span
                  className={(r.daysLeft ?? 0) < 0 ? 'text-destructive' : 'text-muted-foreground'}
                >
                  ({daysLabel(r.daysLeft ?? 0)})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {query.isPending && <p className="m-0 text-muted-foreground">Caricamento…</p>}
      {register && (
        <DataTable
          label={`Registro: ${register.feature.label}`}
          columns={columns}
          data={register.items}
          rowKey={(r) => r.id}
          empty="Nessuna voce. Aggiungi la prima con «Nuova voce»."
          toolbar={
            <>
              <Label className="w-full sm:w-56">
                Cerca
                <Input
                  type="search"
                  value={filters.search}
                  onChange={(e) => set({ search: e.target.value })}
                />
              </Label>
              <Label>
                Stato
                <NativeSelect
                  className="w-auto"
                  value={filters.state}
                  onChange={(e) => set({ state: e.target.value as SectorRecordState | '' })}
                >
                  <option value="">Valide</option>
                  <option value="voided">Annullate</option>
                  <option value="all">Tutte</option>
                </NativeSelect>
              </Label>
              {kinds.length > 1 && (
                <Label>
                  Tipo
                  <NativeSelect
                    className="w-auto"
                    value={filters.kind}
                    onChange={(e) => set({ kind: e.target.value })}
                  >
                    <option value="">Tutti</option>
                    {kinds.map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.label}
                      </option>
                    ))}
                  </NativeSelect>
                </Label>
              )}
              <Label>
                Dal
                <Input
                  type="date"
                  className="w-auto"
                  value={filters.from}
                  onChange={(e) => set({ from: e.target.value })}
                />
              </Label>
              <Label>
                Al
                <Input
                  type="date"
                  className="w-auto"
                  value={filters.to}
                  onChange={(e) => set({ to: e.target.value })}
                />
              </Label>
            </>
          }
          pagination={{
            page: register.page,
            totalPages: register.totalPages,
            total: register.total,
            noun: ['voce', 'voci'],
            limit: filters.limit,
            onPage: (page) => setFilters((f) => ({ ...f, page })),
            onLimit: (limit) => setFilters((f) => ({ ...f, limit, page: 1 })),
          }}
        />
      )}
    </div>
  );
}

/** The title of an entry and its other filled fields, in one cell. */
function EntrySummary({
  record,
  kinds,
}: {
  record: SectorRecord;
  kinds: readonly SectorRecordKind[];
}) {
  const kind = kinds.find((k) => k.kind === record.kind);
  const details = (kind?.fields ?? [])
    .filter(
      (f) =>
        !kind?.titleFields.includes(f.key) &&
        f.key !== kind?.dateField &&
        f.key !== kind?.dueField &&
        f.key !== 'notes',
    )
    .map((f) => [f.label, fieldValueLabel(f, record.data[f.key])] as const)
    .filter(([, v]) => v !== '');
  return (
    <div className="flex flex-col gap-0.5">
      {record.voided && (
        <span className="text-sm text-destructive">
          <Badge variant="outline" className="mr-2 px-1.5 text-destructive">
            Annullata
          </Badge>
          il {isoToItalian(record.voided.at.slice(0, 10))}: {record.voided.reason}
        </span>
      )}
      <span className={record.voided ? 'font-medium line-through' : 'font-medium'}>
        {record.title}
        {record.attachments.length > 0 && (
          <span className="ml-2 text-sm font-normal text-muted-foreground" title="File allegati">
            📎 {record.attachments.length}
          </span>
        )}
      </span>
      {details.length > 0 && (
        <span className="text-sm text-muted-foreground">
          {details.map(([label, value]) => `${label}: ${value}`).join(' · ')}
        </span>
      )}
      {record.notify && (
        <span className="text-sm text-muted-foreground">Avvisa: {record.notify.label}</span>
      )}
      {(record.version ?? 1) > 1 && !record.voided && (
        <span className="text-sm text-muted-foreground">
          Rettificata (versione {record.version})
        </span>
      )}
    </div>
  );
}

function EntryForm({
  channel,
  featureId,
  kinds,
  people,
  editing,
  onDone,
  onCancel,
}: {
  channel: SectorChannel;
  featureId: string;
  kinds: readonly SectorRecordKind[];
  people: readonly SectorPerson[];
  editing: Exclude<Editing, null>;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const { api } = useSession();
  const [kindId, setKindId] = useState(
    editing.mode === 'edit' ? editing.record.kind : editing.kind,
  );
  const kind = kinds.find((k) => k.kind === kindId) ?? kinds[0];
  const [values, setValues] = useState<Record<string, string>>(() =>
    editing.mode === 'edit' ? dataToForm(kind, editing.record.data) : {},
  );
  const [problem, setProblem] = useState<string | null>(null);
  // A correction says why; the previous content stays in the history of the entry.
  const [reason, setReason] = useState('');

  const save = useMutation({
    mutationFn: () => {
      const data = formToData(kind, values);
      return editing.mode === 'edit'
        ? api(sectorPath(channel, featureId, editing.record.id), {
            method: 'PATCH',
            body: {
              data,
              reason: reason.trim(),
              ...(editing.record.version ? { expectedVersion: editing.record.version } : {}),
            },
          })
        : api(sectorPath(channel, featureId), {
            method: 'POST',
            body: { kind: kind.kind, data },
          });
    },
    onSuccess: onDone,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missing = missingRequired(kind, values);
    if (missing) {
      setProblem(`Compila «${missing.label}».`);
      return;
    }
    const noReason = editing.mode === 'edit' ? reasonProblem(reason, 'rettifica') : null;
    if (noReason) {
      setProblem(noReason);
      return;
    }
    setProblem(null);
    save.mutate();
  };

  const title = editing.mode === 'edit' ? `Rettifica: ${editing.record.title}` : 'Nuova voce';
  return (
    <form
      className="flex max-w-3xl flex-col gap-3 rounded-lg border p-4"
      onSubmit={submit}
      aria-labelledby="entry-form"
    >
      <h2 id="entry-form" className="m-0 text-lg font-semibold">
        {title}
      </h2>
      {editing.mode === 'new' && kinds.length > 1 && (
        <Label>
          Tipo di voce
          <NativeSelect
            value={kindId}
            onChange={(e) => {
              setKindId(e.target.value);
              setValues({});
            }}
          >
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </NativeSelect>
        </Label>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {kind.fields.map((field) => (
          <FieldInput
            key={field.key}
            field={field}
            value={values[field.key] ?? ''}
            onChange={(v) => setValues((old) => ({ ...old, [field.key]: v }))}
          />
        ))}
        {kind.notify && people.length > 0 && (
          <Label>
            {kind.notify}
            <NativeSelect
              value={values[NOTIFY_KEY] ?? ''}
              onChange={(e) => setValues((old) => ({ ...old, [NOTIFY_KEY]: e.target.value }))}
            >
              <option value="">Nessuna (solo gli amministratori)</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </NativeSelect>
          </Label>
        )}
      </div>
      {editing.mode === 'edit' && (
        <Label>
          Motivo della rettifica *
          <textarea
            className="min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-sm"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Label>
      )}
      {editing.mode === 'edit' && (
        <p className="m-0 text-sm text-muted-foreground">
          Il contenuto di prima resta nello storico della voce.
        </p>
      )}
      {(problem || save.isError) && (
        <p className="error m-0" role="alert">
          {problem ?? describeError(save.error)}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Salvataggio…' : 'Salva'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Annulla
        </Button>
      </div>
    </form>
  );
}

/** Voiding an entry: why, then confirmed. The entry stays in the register, marked as voided. */
function VoidForm({
  channel,
  featureId,
  record,
  onDone,
  onCancel,
}: {
  channel: SectorChannel;
  featureId: string;
  record: SectorRecord;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const { api } = useSession();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const voidIt = useMutation({
    mutationFn: () =>
      api(sectorVoidPath(channel, featureId, record.id), {
        method: 'POST',
        body: {
          reason: reason.trim(),
          ...(record.version ? { expectedVersion: record.version } : {}),
        },
      }),
    onSuccess: onDone,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const noReason = reasonProblem(reason, 'annullamento');
    setProblem(noReason);
    if (!noReason) voidIt.mutate();
  };
  return (
    <form
      className="flex max-w-3xl flex-col gap-3 rounded-lg border p-4"
      onSubmit={submit}
      aria-labelledby="void-form"
    >
      <h2 id="void-form" className="m-0 text-lg font-semibold">
        Annulla: {record.title}
      </h2>
      <p className="m-0 text-muted-foreground">
        La voce non viene cancellata: resta nel registro come annullata, con i suoi file e il suo
        storico, e la sua scadenza viene chiusa.
      </p>
      <Label>
        Motivo dell’annullamento *
        <textarea
          className="min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Label>
      {(problem || voidIt.isError) && (
        <p className="error m-0" role="alert">
          {problem ?? describeError(voidIt.error)}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="destructive" disabled={voidIt.isPending}>
          {voidIt.isPending ? 'Annullamento…' : 'Conferma annullamento'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Chiudi
        </Button>
      </div>
    </form>
  );
}

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const CHANNELS: Record<string, string> = { dashboard: 'dashboard', miniapp: 'Mini App' };

/** The history of an entry: every version, who and why, and what each correction changed. */
function EntryHistory({
  channel,
  featureId,
  record,
  kind,
  onClose,
}: {
  channel: SectorChannel;
  featureId: string;
  record: SectorRecord;
  kind: SectorRecordKind | undefined;
  onClose: () => void;
}) {
  const { api } = useSession();
  const versions = useQuery({
    queryKey: ['sector-versions', channel, featureId, record.id, record.version],
    queryFn: () => api<SectorRecordVersion[]>(sectorVersionsPath(channel, featureId, record.id)),
  });
  return (
    <section
      aria-labelledby="entry-history"
      className="flex max-w-3xl flex-col gap-3 rounded-lg border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="entry-history" className="m-0 text-lg font-semibold">
          Storico: {record.title}
        </h2>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Chiudi
        </Button>
      </div>
      {versions.isPending && <p className="m-0 text-muted-foreground">Caricamento…</p>}
      {versions.isError && (
        <p className="error m-0" role="alert">
          {describeError(versions.error)}
        </p>
      )}
      {versions.data && (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {versions.data.map((v, i) => {
            const changes =
              i > 0 && v.action === 'CORRECTED'
                ? versionChanges(kind, versions.data[i - 1].data, v.data)
                : [];
            return (
              <li key={v.version} className="flex flex-col gap-0.5 border-l-2 pl-3">
                <span className="font-medium">
                  Versione {v.version} · {VERSION_ACTIONS[v.action]} il {dateTime(v.changedAt)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {v.author ?? 'persona non più presente'}
                  {v.channel ? ` · ${CHANNELS[v.channel] ?? v.channel}` : ''}
                </span>
                {v.reason && <span className="text-sm">Motivo: {v.reason}</span>}
                {changes.length > 0 && (
                  <ul className="m-0 pl-4 text-sm">
                    {changes.map((c) => (
                      <li key={c.label}>
                        {c.label}: {c.before || '—'} → {c.after || '—'}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: SectorField;
  value: string;
  onChange: (value: string) => void;
}) {
  const label = `${field.label}${field.required ? ' *' : ''}`;
  const wide = field.key === 'notes' ? 'sm:col-span-2' : '';
  if (field.type === 'choice') {
    return (
      <Label className={wide}>
        {label}
        <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </Label>
    );
  }
  if (field.key === 'notes') {
    return (
      <Label className={wide}>
        {label}
        <textarea
          className="min-h-20 w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          maxLength={field.maxLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </Label>
    );
  }
  return (
    <Label className={wide}>
      {label}
      <Input
        type={field.type === 'date' ? 'date' : 'text'}
        inputMode={field.type === 'number' ? 'decimal' : undefined}
        maxLength={field.type === 'text' ? field.maxLength : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Label>
  );
}

const FORMATS: Array<{ format: SectorExportFormat; label: string }> = [
  { format: 'csv', label: 'CSV' },
  { format: 'xlsx', label: 'Excel' },
  { format: 'pdf', label: 'PDF' },
];

/** The register as a file, with the filters of the page; saved, never opened in the page. */
function ExportButtons({
  channel,
  featureId,
  filters,
}: {
  channel: SectorChannel;
  featureId: string;
  filters: SectorFilters;
}) {
  const { download } = useSession();
  const [busy, setBusy] = useState<SectorExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (format: SectorExportFormat) => {
    setBusy(format);
    setError(null);
    try {
      const { blob, fileName } = await download(
        sectorExportPath(channel, featureId, format, filters),
      );
      saveBlob(blob, fileName);
    } catch (err: unknown) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label="Esporta il registro"
    >
      <span className="text-sm text-muted-foreground">Esporta:</span>
      {FORMATS.map(({ format, label }) => (
        <Button
          key={format}
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          aria-label={`Esporta in ${label}`}
          onClick={() => void run(format)}
        >
          {busy === format ? '…' : label}
        </Button>
      ))}
      {error && (
        <p className="error m-0 w-full" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The files of an entry: download, add (PDF or photo), remove. */
function EntryFiles({
  channel,
  featureId,
  record,
  canManage,
  canRemove = canManage,
  onChange,
}: {
  channel: SectorChannel;
  featureId: string;
  record: SectorRecord;
  canManage: boolean;
  /** Whether files can be removed (never through a delegation). */
  canRemove?: boolean;
  onChange: (record: SectorRecord) => Promise<void>;
}) {
  const { api, download } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (chosen: File) => {
      const form = new FormData();
      form.append('file', chosen);
      return api<SectorRecord>(sectorFilePath(channel, featureId, record.id), {
        method: 'POST',
        form,
      });
    },
    onSuccess: async (updated) => {
      setFile(null);
      setInputKey((k) => k + 1);
      await onChange(updated);
    },
  });
  const remove = useMutation({
    mutationFn: (attachmentId: string) =>
      api<SectorRecord>(sectorFilePath(channel, featureId, record.id, attachmentId), {
        method: 'DELETE',
      }),
    onSuccess: onChange,
  });
  const save = async (attachmentId: string) => {
    setError(null);
    try {
      const { blob, fileName } = await download(
        `${sectorFilePath(channel, featureId, record.id, attachmentId)}/download`,
      );
      saveBlob(blob, fileName);
    } catch (err: unknown) {
      setError(describeError(err));
    }
  };
  const failure =
    error ??
    (upload.isError ? describeError(upload.error) : null) ??
    (remove.isError ? describeError(remove.error) : null);

  return (
    <section
      aria-labelledby="entry-files"
      className="flex max-w-3xl flex-col gap-3 rounded-lg border p-4"
    >
      <h2 id="entry-files" className="m-0 text-lg font-semibold">
        File allegati
      </h2>
      {record.attachments.length === 0 ? (
        <p className="m-0 text-muted-foreground">Nessun file allegato a questa voce.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {record.attachments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{a.fileName}</span>
              <span className="text-sm text-muted-foreground">{fileSizeLabel(a.fileSize)}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Scarica ${a.fileName}`}
                onClick={() => void save(a.id)}
              >
                Scarica
              </Button>
              {canRemove && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Rimuovi ${a.fileName}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(a.id)}
                >
                  Rimuovi
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="flex flex-wrap items-end gap-2">
          <Label>
            Aggiungi un file (PDF o foto)
            <Input
              key={inputKey}
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Label>
          <Button
            type="button"
            disabled={!file || upload.isPending}
            onClick={() => file && upload.mutate(file)}
          >
            {upload.isPending ? 'Caricamento…' : 'Carica'}
          </Button>
        </div>
      )}
      {failure && (
        <p className="error m-0" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
