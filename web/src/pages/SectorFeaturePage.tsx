import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { Navigate, useParams } from 'react-router';

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

type Editing = { mode: 'new'; kind: string } | { mode: 'edit'; record: SectorRecord } | null;

function SectorRegister({ me, featureId }: { me: Me; featureId: string }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<
    Required<Pick<SectorFilters, 'page' | 'limit'>> & SectorFilters
  >({ page: 1, limit: 20, kind: '', search: '', from: '', to: '' });
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const key = ['sector', me.current.orgId, featureId];

  const query = useQuery({
    queryKey: [...key, filters],
    queryFn: () => api<SectorRegisterPage>(sectorRecordsQuery('dashboard', featureId, filters)),
    placeholderData: keepPreviousData,
  });
  const register = query.data;
  const kinds = register?.kinds ?? [];
  const hasExpiry = kinds.some((k) => k.dueField);
  const expiring = useQuery({
    queryKey: [...key, 'expiring'],
    queryFn: () =>
      api<SectorRegisterPage>(
        sectorRecordsQuery('dashboard', featureId, { expiringWithinDays: 60, limit: 5 }),
      ),
    enabled: hasExpiry,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(sectorPath('dashboard', featureId, id), { method: 'DELETE' }),
    onSuccess: async () => {
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: key });
    },
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
      ...(register?.canManage
        ? [
            {
              id: 'actions',
              header: 'Azioni',
              enableHiding: false,
              meta: { label: 'Azioni', className: 'whitespace-nowrap' },
              cell: ({ row }: { row: { original: SectorRecord } }) =>
                deleting === row.original.id ? (
                  <span className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(row.original.id)}
                    >
                      Conferma eliminazione
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setDeleting(null)}
                    >
                      Annulla
                    </Button>
                  </span>
                ) : (
                  <span className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`Modifica ${row.original.title}`}
                      onClick={() => setEditing({ mode: 'edit', record: row.original })}
                    >
                      Modifica
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Elimina ${row.original.title}`}
                      onClick={() => setDeleting(row.original.id)}
                    >
                      Elimina
                    </Button>
                  </span>
                ),
            } satisfies DataColumn<SectorRecord>,
          ]
        : []),
    ],
    [deleting, hasExpiry, kinds, register?.canManage, remove],
  );

  const set = (patch: Partial<SectorFilters>) => setFilters((f) => ({ ...f, page: 1, ...patch }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-2xl font-semibold tracking-tight">
            {register?.feature.label ?? 'Registro'}
          </h1>
          {register && <p className="m-0 text-muted-foreground">{register.feature.description}</p>}
        </div>
        {register?.canManage && kinds.length > 0 && (
          <Button type="button" onClick={() => setEditing({ mode: 'new', kind: kinds[0].kind })}>
            Nuova voce
          </Button>
        )}
      </div>

      {query.isError && (
        <p className="error m-0" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {remove.isError && (
        <p className="error m-0" role="alert">
          {describeError(remove.error)}
        </p>
      )}

      {editing && register && (
        <EntryForm
          featureId={featureId}
          kinds={kinds}
          editing={editing}
          onDone={async () => {
            setEditing(null);
            await queryClient.invalidateQueries({ queryKey: key });
          }}
          onCancel={() => setEditing(null)}
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
      <span className="font-medium">{record.title}</span>
      {details.length > 0 && (
        <span className="text-sm text-muted-foreground">
          {details.map(([label, value]) => `${label}: ${value}`).join(' · ')}
        </span>
      )}
    </div>
  );
}

function EntryForm({
  featureId,
  kinds,
  editing,
  onDone,
  onCancel,
}: {
  featureId: string;
  kinds: readonly SectorRecordKind[];
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

  const save = useMutation({
    mutationFn: () => {
      const data = formToData(kind, values);
      return editing.mode === 'edit'
        ? api(sectorPath('dashboard', featureId, editing.record.id), {
            method: 'PATCH',
            body: { data },
          })
        : api(sectorPath('dashboard', featureId), {
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
    setProblem(null);
    save.mutate();
  };

  const title = editing.mode === 'edit' ? `Modifica: ${editing.record.title}` : 'Nuova voce';
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
      </div>
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
