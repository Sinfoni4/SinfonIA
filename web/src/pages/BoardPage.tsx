import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';

import { describeError, type Me } from '../api/client';
import {
  assigneeLabel,
  BOARD_COLUMN_SIZE,
  BOARD_STATES,
  boardQuery,
  formatDate,
  NEXT_STATES,
  STATE_LABELS,
  TRANSITION_LABELS,
  type Assignee,
  type BoardFilter,
  type Practice,
  type PracticePage,
  type PracticeState,
} from '../api/practices';
import { useSession } from '../session/session';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';

const FILTERS: Array<{ value: BoardFilter; label: string }> = [
  { value: 'all', label: 'Tutte' },
  { value: 'me', label: 'Assegnate a me' },
  { value: 'none', label: 'Non assegnate' },
];

/**
 * A4: the practices of the organization as a board, one column per state. Administrators and
 * operators assign a practice to someone and move it to the next state (with a confirmation).
 */
export function BoardPage({ me }: { me: Me }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const staff = me.current.role !== 'MEMBER';
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [error, setError] = useState<string | null>(null);

  const columns = useQueries({
    queries: BOARD_STATES.map((state) => ({
      queryKey: ['board', me.current.orgId, state, filter],
      queryFn: () => api<PracticePage>(boardQuery(state, filter)),
      enabled: staff,
    })),
  });
  const assignees = useQuery({
    queryKey: ['assignees', me.current.orgId],
    queryFn: () => api<Assignee[]>('/practices/assignees'),
    enabled: staff,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['board'] });
    await queryClient.invalidateQueries({ queryKey: ['practices'] });
  };
  const assign = useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string | null }) =>
      api(`/practices/${id}/assign`, { method: 'POST', body: { userId } }),
    onSuccess: refresh,
    onError: (err: unknown) => setError(describeError(err)),
  });
  const move = useMutation({
    mutationFn: ({ id, nextState }: { id: string; nextState: PracticeState }) =>
      api(`/practices/${id}/transition`, { method: 'POST', body: { nextState } }),
    onSuccess: refresh,
    onError: (err: unknown) => setError(describeError(err)),
  });

  if (!staff) {
    return (
      <>
        <h1>Bacheca</h1>
        <p className="muted">
          La bacheca è per amministratori e operatori. Le tue pratiche sono in{' '}
          <Link to="/pratiche">Pratiche</Link>.
        </p>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="m-0">Bacheca</h1>
        <nav
          className="inline-flex flex-wrap gap-1 rounded-lg bg-secondary p-1"
          aria-label="Quali pratiche"
        >
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={filter === f.value ? 'outline' : 'ghost'}
              className={cn(filter === f.value && 'shadow-xs')}
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </nav>
      </div>
      {error && (
        <p className="error m-0" role="alert">
          {error}
        </p>
      )}
      <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))]">
        {BOARD_STATES.map((state, i) => {
          const column = columns[i];
          return (
            <section
              key={state}
              className="m-0 flex min-w-0 flex-col gap-2 rounded-lg bg-secondary/60 p-2"
              aria-labelledby={`col-${state}`}
            >
              <h2
                id={`col-${state}`}
                className="m-0 flex items-center justify-between px-1 text-sm font-semibold"
              >
                {STATE_LABELS[state]}
                {column.data ? <Badge variant="outline">{column.data.total}</Badge> : null}
              </h2>
              {column.isPending && (
                <p className="m-0 px-1 text-sm text-muted-foreground">Caricamento…</p>
              )}
              {column.isError && (
                <p className="error m-0" role="alert">
                  {describeError(column.error)}
                </p>
              )}
              {column.data?.items.length === 0 && (
                <p className="m-0 px-1 text-sm text-muted-foreground">Nessuna pratica.</p>
              )}
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {column.data?.items.map((p) => (
                  <BoardCard
                    key={p.id}
                    practice={p}
                    assignees={assignees.data ?? []}
                    busy={assign.isPending || move.isPending}
                    onAssign={(userId) => {
                      setError(null);
                      assign.mutate({ id: p.id, userId });
                    }}
                    onMove={(nextState) => {
                      setError(null);
                      move.mutate({ id: p.id, nextState });
                    }}
                  />
                ))}
              </ul>
              {column.data && column.data.total > BOARD_COLUMN_SIZE && (
                <p className="m-0 px-1 text-sm text-muted-foreground">
                  Mostrate le {BOARD_COLUMN_SIZE} più recenti:{' '}
                  <Link to="/pratiche">vedi tutte</Link>.
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function BoardCard({
  practice,
  assignees,
  busy,
  onAssign,
  onMove,
}: {
  practice: Practice;
  assignees: Assignee[];
  busy: boolean;
  onAssign: (userId: string | null) => void;
  onMove: (nextState: PracticeState) => void;
}) {
  const [confirm, setConfirm] = useState<PracticeState | null>(null);
  const next = NEXT_STATES[practice.status];
  const assigned = assignees.find((a) => a.userId === practice.assignedTo);
  return (
    <li>
      <Card className="gap-3 p-3">
        <CardHeader>
          <CardTitle>
            <Link to={`/pratiche/${practice.id}`} className="text-foreground hover:text-primary">
              {practice.name}
            </Link>
          </CardTitle>
          <CardDescription>Aggiornata il {formatDate(practice.updatedAt)}</CardDescription>
        </CardHeader>
        <Label className="text-xs text-muted-foreground">
          Assegnata a
          <NativeSelect
            value={practice.assignedTo ?? ''}
            disabled={busy}
            onChange={(e) => onAssign(e.target.value || null)}
            aria-label={`Assegna «${practice.name}»`}
          >
            <option value="">Nessuno</option>
            {practice.assignedTo && !assigned && (
              <option value={practice.assignedTo}>persona non più attiva</option>
            )}
            {assignees.map((a) => (
              <option key={a.userId} value={a.userId}>
                {assigneeLabel(a)}
              </option>
            ))}
          </NativeSelect>
        </Label>
        {next.length > 0 && (
          <CardFooter>
            {confirm ? (
              <>
                <span className="w-full text-sm">Confermi «{TRANSITION_LABELS[confirm]}»?</span>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    onMove(confirm);
                    setConfirm(null);
                  }}
                >
                  Conferma
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                  Annulla
                </Button>
              </>
            ) : (
              next.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirm(s)}
                >
                  {TRANSITION_LABELS[s]}
                </Button>
              ))
            )}
          </CardFooter>
        )}
      </Card>
    </li>
  );
}
