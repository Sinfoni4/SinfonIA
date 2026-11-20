import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';

import { describeError } from '../api/client';
import {
  FEATURE_LABELS,
  FEATURE_SHORT_LABELS,
  FEATURES,
  MODULE_LABELS,
  MODULES,
  moduleLabel,
  organizationsQuery,
  TYPE_LABELS,
  TYPES,
  type FeatureCatalog,
  type ModuleId,
  type OrganizationPage,
  type OrganizationRow,
  type OrganizationType,
} from '../api/platform';
import { DataTable, type DataColumn } from '../components/DataTable';
import { useSession } from '../session/session';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

/** Functions of a sector only: where it is turned on. */
type Channel = 'dashboard' | 'miniapp';
type Toggle = { orgId: string; feature: string; enabled: boolean; channel?: Channel };

const CHANNEL_LABELS: Record<Channel, string> = {
  dashboard: 'nella dashboard',
  miniapp: 'nella Mini App',
};

/**
 * The functions of every organization in one table: the common ones (on unless turned off) in a
 * column each, those of the organization's sector in the last column (off until turned on).
 * Each box saves at once; the backend refuses a function turned off, whatever the menu shows.
 */
export function PlatformFeaturesPage() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<{
    page: number;
    search: string;
    type: OrganizationType | '';
    module: ModuleId | '';
    limit: number;
  }>({ page: 1, search: '', type: '', module: '', limit: 20 });
  const catalog = useQuery({
    queryKey: ['platform', 'features'],
    queryFn: () => api<FeatureCatalog>('/platform/features'),
    staleTime: Infinity,
  });
  const query = useQuery({
    queryKey: ['platform', 'organizations', 'features', filters],
    queryFn: () => api<OrganizationPage>(organizationsQuery({ ...filters, status: '' })),
    placeholderData: keepPreviousData,
  });
  const [pending, setPending] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: ({ orgId, feature, enabled, channel }: Toggle) =>
      api(`/platform/organizations/${orgId}/features/${feature}`, {
        method: 'PATCH',
        body: channel ? { enabled, channel } : { enabled },
      }),
    onMutate: ({ orgId, feature, channel }) => setPending(`${orgId}:${feature}:${channel ?? ''}`),
    onSettled: async () => {
      setPending(null);
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
  });
  const sector = catalog.data?.sector;

  const columns = useMemo<Array<DataColumn<OrganizationRow>>>(() => {
    const box = (
      o: OrganizationRow,
      feature: string,
      on: boolean,
      label: string,
      channel?: Channel,
    ) => (
      <input
        type="checkbox"
        className="size-4 accent-primary"
        checked={on}
        disabled={pending === `${o.id}:${feature}:${channel ?? ''}`}
        aria-label={`${label}${channel ? ` ${CHANNEL_LABELS[channel]}` : ''} per ${o.name}`}
        onChange={(e) =>
          toggle.mutate({ orgId: o.id, feature, enabled: e.target.checked, channel })
        }
      />
    );
    return [
      {
        id: 'name',
        header: 'Organizzazione',
        enableHiding: false,
        meta: { label: 'Organizzazione' },
        cell: ({ row: { original: o } }) => (
          <Link to={`/piattaforma/organizzazioni/${o.id}`} className="font-medium">
            {o.name}
          </Link>
        ),
      },
      {
        id: 'module',
        header: 'Settore',
        meta: { label: 'Settore', className: 'whitespace-nowrap' },
        cell: ({ row }) => moduleLabel(row.original.module),
      },
      ...FEATURES.map<DataColumn<OrganizationRow>>((f) => ({
        id: f,
        header: () => <span title={FEATURE_LABELS[f]}>{FEATURE_SHORT_LABELS[f]}</span>,
        meta: { label: FEATURE_LABELS[f], className: 'text-center' },
        cell: ({ row: { original: o } }) =>
          box(o, f, !(o.disabledFeatures ?? []).includes(f), FEATURE_LABELS[f]),
      })),
      {
        id: 'sector',
        header: 'Funzioni di settore',
        meta: { label: 'Funzioni di settore' },
        cell: ({ row: { original: o } }) => {
          const own = (sector ?? []).filter((f) => f.modules.includes(o.module));
          if (own.length === 0) return <span className="text-muted-foreground">—</span>;
          return (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {own.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{f.label}</span>
                  {!f.ready && (
                    <Badge variant="outline" className="px-1.5 text-muted-foreground">
                      in preparazione
                    </Badge>
                  )}
                  <span className="flex items-center gap-3 whitespace-nowrap">
                    <label className="flex items-center gap-1.5">
                      {box(o, f.id, (o.enabledFeatures ?? []).includes(f.id), f.label, 'dashboard')}
                      Dashboard
                    </label>
                    <label className="flex items-center gap-1.5">
                      {box(o, f.id, (o.miniAppFeatures ?? []).includes(f.id), f.label, 'miniapp')}
                      Mini App
                    </label>
                  </span>
                </li>
              ))}
            </ul>
          );
        },
      },
    ];
  }, [pending, sector, toggle]);

  const data = query.data;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="m-0 text-2xl font-semibold tracking-tight">Funzioni</h1>
      <p className="m-0 max-w-3xl text-muted-foreground">
        Le funzioni comuni sono accese per tutti finché non le spegni. Quelle di settore compaiono
        solo per le organizzazioni di quel settore, partono spente e si accendono a parte nella
        dashboard e nella Mini App di Telegram (nel menu). Ogni casella si salva subito e vale dalla
        richiesta successiva; spegnere non cancella i dati.
      </p>
      {(query.isError || catalog.isError) && (
        <p className="error m-0" role="alert">
          {describeError(query.error ?? catalog.error)}
        </p>
      )}
      {toggle.isError && (
        <p className="error m-0" role="alert">
          {describeError(toggle.error)}
        </p>
      )}
      {query.isPending && <p className="m-0 text-muted-foreground">Caricamento…</p>}
      {data && (
        <DataTable
          label="Funzioni delle organizzazioni"
          columns={columns}
          data={data.items}
          rowKey={(o) => o.id}
          empty="Nessuna organizzazione."
          toolbar={
            <>
              <Label className="w-full sm:w-64">
                Cerca
                <Input
                  type="search"
                  value={filters.search}
                  onChange={(e) => setFilters((f) => ({ ...f, page: 1, search: e.target.value }))}
                />
              </Label>
              <Label>
                Settore
                <NativeSelect
                  className="w-auto"
                  value={filters.module}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, page: 1, module: e.target.value as ModuleId | '' }))
                  }
                >
                  <option value="">Tutti</option>
                  {MODULES.map((m) => (
                    <option key={m} value={m}>
                      {MODULE_LABELS[m]}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
              <Label>
                Tipo
                <NativeSelect
                  className="w-auto"
                  value={filters.type}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      page: 1,
                      type: e.target.value as OrganizationType | '',
                    }))
                  }
                >
                  <option value="">Tutti</option>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
            </>
          }
          pagination={{
            page: data.page,
            totalPages: data.totalPages,
            total: data.total,
            noun: ['organizzazione', 'organizzazioni'],
            limit: filters.limit,
            onPage: (page) => setFilters((f) => ({ ...f, page })),
            onLimit: (limit) => setFilters((f) => ({ ...f, limit, page: 1 })),
          }}
        />
      )}
    </div>
  );
}
