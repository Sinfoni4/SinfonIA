import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, CircleX, Plus, Search } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';

import { describeError, type Me } from '../api/client';
import {
  formatDate,
  isMine,
  kindLabel,
  PAGE_SIZE,
  practicesQuery,
  STATE_LABELS,
  type Practice,
  type PracticeFilters,
  type PracticePage,
  type PracticeState,
} from '../api/practices';
import { DataTable, type DataColumn } from '../components/DataTable';
import { useSession } from '../session/session';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

/** The state of a practice as the status badges of dashboard-01: an icon and the word. */
export function StateBadge({ state }: { state: PracticeState }) {
  const Icon = state === 'COMPLETED' ? CircleCheck : state === 'FAILED' ? CircleX : CircleDashed;
  return (
    <Badge variant="outline" className="px-1.5 text-muted-foreground">
      <Icon
        aria-hidden
        className={
          state === 'COMPLETED'
            ? 'fill-green-600 text-white'
            : state === 'FAILED'
              ? 'fill-destructive text-white'
              : undefined
        }
      />
      <span className="text-foreground">{STATE_LABELS[state]}</span>
    </Badge>
  );
}

/** P3: practices, paginated, with search and status filter; the perimeter is the backend's. */
export function PracticesPage({ me }: { me: Me }) {
  const { api } = useSession();
  // ADMIN and OPERATOR see the organization; a MEMBER sees only their own anyway.
  const seesOrganization = me.current.role !== 'MEMBER';
  const [filters, setFilters] = useState<PracticeFilters>({
    page: 1,
    search: '',
    status: '',
    mine: false,
    limit: PAGE_SIZE,
  });
  const [search, setSearch] = useState('');

  const query = useQuery({
    queryKey: ['practices', me.current.orgId, filters],
    queryFn: () => api<PracticePage>(practicesQuery(filters, me.userId)),
    placeholderData: keepPreviousData,
  });

  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setFilters((f) => ({ ...f, search, page: 1 }));
  };

  const columns = useMemo<Array<DataColumn<Practice>>>(
    () => [
      {
        id: 'name',
        header: 'Nome',
        enableHiding: false,
        meta: { label: 'Nome' },
        cell: ({ row: { original: p } }) => (
          <span className="flex flex-wrap items-center gap-2">
            <Link to={`/pratiche/${p.id}`} className="font-medium">
              {p.name}
            </Link>
            {seesOrganization && isMine(p, me.userId) && <Badge>mia</Badge>}
            {p.holderUserId && p.holderUserId !== me.userId && (
              <Badge variant="outline">aperta per un'altra persona</Badge>
            )}
          </span>
        ),
      },
      {
        id: 'kind',
        header: 'Tipo',
        meta: { label: 'Tipo', className: 'hidden md:table-cell' },
        cell: ({ row }) => (
          <Badge variant="outline" className="px-1.5 text-muted-foreground">
            {kindLabel(row.original)}
          </Badge>
        ),
      },
      {
        id: 'status',
        header: 'Stato',
        meta: { label: 'Stato' },
        cell: ({ row }) => <StateBadge state={row.original.status} />,
      },
      {
        id: 'updatedAt',
        header: 'Aggiornata',
        meta: { label: 'Aggiornata', className: 'whitespace-nowrap' },
        cell: ({ row }) => formatDate(row.original.updatedAt),
      },
    ],
    [seesOrganization, me.userId],
  );

  const data = query.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="m-0 text-2xl font-semibold tracking-tight">Pratiche</h1>
        <Button asChild>
          <Link to="/pratiche/nuova">
            <Plus aria-hidden />
            Nuova pratica
          </Link>
        </Button>
      </div>

      {query.isError && (
        <p className="error m-0" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="m-0 text-muted-foreground">Caricamento…</p>}
      {data && (
        <DataTable
          label="Elenco delle pratiche"
          columns={columns}
          data={data.items}
          rowKey={(p) => p.id}
          empty="Nessuna pratica trovata."
          toolbar={
            <form className="flex flex-wrap items-end gap-3" onSubmit={applySearch} role="search">
              <Label className="w-full sm:w-64">
                Cerca
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Nome della pratica"
                />
              </Label>
              <Label>
                Stato
                <NativeSelect
                  className="w-auto"
                  value={filters.status}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      status: e.target.value as PracticeState | '',
                      page: 1,
                    }))
                  }
                >
                  <option value="">Tutti</option>
                  {(Object.keys(STATE_LABELS) as PracticeState[]).map((s) => (
                    <option key={s} value={s}>
                      {STATE_LABELS[s]}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
              {seesOrganization && (
                <label className="m-0 flex h-9 items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    className="m-0 size-4 p-0 accent-primary"
                    checked={filters.mine}
                    onChange={(e) => setFilters((f) => ({ ...f, mine: e.target.checked, page: 1 }))}
                  />
                  Solo le mie
                </label>
              )}
              <Button type="submit" variant="outline" className="text-foreground">
                <Search aria-hidden />
                Cerca
              </Button>
            </form>
          }
          pagination={{
            page: data.page,
            totalPages: data.totalPages,
            total: data.total,
            noun: ['pratica', 'pratiche'],
            limit: filters.limit,
            onPage: (page) => setFilters((f) => ({ ...f, page })),
            onLimit: (limit) => setFilters((f) => ({ ...f, limit, page: 1 })),
          }}
        />
      )}
    </div>
  );
}
