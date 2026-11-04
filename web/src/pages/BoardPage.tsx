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
    <>
      <div className="page-head">
        <h1>Bacheca</h1>
        <nav className="tabs" aria-label="Quali pratiche">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`link ${filter === f.value ? 'active' : ''}`}
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </nav>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="board">
        {BOARD_STATES.map((state, i) => {
          const column = columns[i];
          return (
            <section key={state} className="board-column" aria-labelledby={`col-${state}`}>
              <h2 id={`col-${state}`}>
                {STATE_LABELS[state]}
                {column.data ? <span className="muted"> ({column.data.total})</span> : null}
              </h2>
              {column.isPending && <p className="muted">Caricamento…</p>}
              {column.isError && (
                <p className="error" role="alert">
                  {describeError(column.error)}
                </p>
              )}
              {column.data?.items.length === 0 && <p className="muted">Nessuna pratica.</p>}
              <ul className="board-cards">
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
                <p className="muted">
                  Mostrate le {BOARD_COLUMN_SIZE} più recenti:{' '}
                  <Link to="/pratiche">vedi tutte</Link>.
                </p>
              )}
            </section>
          );
        })}
      </div>
    </>
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
    <li className="card board-card">
      <Link to={`/pratiche/${practice.id}`}>
        <strong>{practice.name}</strong>
      </Link>
      <span className="muted">Aggiornata il {formatDate(practice.updatedAt)}</span>
      <label>
        Assegnata a
        <select
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
        </select>
      </label>
      {next.length > 0 && (
        <div className="actions">
          {confirm ? (
            <>
              <span>Confermi «{TRANSITION_LABELS[confirm]}»?</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onMove(confirm);
                  setConfirm(null);
                }}
              >
                Conferma
              </button>
              <button type="button" className="link" onClick={() => setConfirm(null)}>
                Annulla
              </button>
            </>
          ) : (
            next.map((s) => (
              <button
                key={s}
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setConfirm(s)}
              >
                {TRANSITION_LABELS[s]}
              </button>
            ))
          )}
        </div>
      )}
    </li>
  );
}
