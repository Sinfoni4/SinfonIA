import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { describeError, type Me } from '../api/client';
import {
  CATEGORY_LABELS,
  daysLabel,
  deadlinesQuery,
  isoToItalian,
  type Deadline,
  type DeadlineCategory,
  type DeadlineFilters,
} from '../api/compliance';
import { useSession } from '../session/session';

const CATEGORIES = Object.keys(CATEGORY_LABELS) as DeadlineCategory[];

/** P6: compliance deadlines; ADMIN and OPERATOR add and close them, a MEMBER sees their own. */
export function DeadlinesPage({ me }: { me: Me }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  // compliance.manage: ADMIN and OPERATOR (the backend decides anyway).
  const canManage = me.current.role !== 'MEMBER';
  const [filters, setFilters] = useState<DeadlineFilters>({ status: 'OPEN', category: '' });
  const [closing, setClosing] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['deadlines', me.current.orgId, filters],
    queryFn: () => api<Deadline[]>(deadlinesQuery(filters)),
  });

  const close = useMutation({
    mutationFn: (id: string) =>
      api(`/compliance/deadlines/${id}/close`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      setClosing(null);
      await queryClient.invalidateQueries({ queryKey: ['deadlines'] });
    },
  });

  return (
    <>
      <h1>Scadenze</h1>
      <div className="filters">
        <label>
          Stato
          <select
            value={filters.status}
            onChange={(e) =>
              setFilters((f) => ({ ...f, status: e.target.value as DeadlineFilters['status'] }))
            }
          >
            <option value="OPEN">Aperte</option>
            <option value="CLOSED">Chiuse</option>
            <option value="">Tutte</option>
          </select>
        </label>
        <label>
          Categoria
          <select
            value={filters.category}
            onChange={(e) =>
              setFilters((f) => ({ ...f, category: e.target.value as DeadlineCategory | '' }))
            }
          >
            <option value="">Tutte</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {query.data && query.data.length === 0 && <p className="muted">Nessuna scadenza.</p>}
      {query.data && query.data.length > 0 && (
        <table className="list">
          <thead>
            <tr>
              <th scope="col">Scadenza</th>
              <th scope="col">Categoria</th>
              <th scope="col">Titolo</th>
              {canManage && <th scope="col">Azioni</th>}
            </tr>
          </thead>
          <tbody>
            {query.data.map((d) => (
              <tr key={d.id}>
                <td>
                  {isoToItalian(d.dueDate)}
                  <br />
                  {d.status === 'OPEN' ? (
                    <span className={`state ${d.daysLeft < 0 ? 'state-failed' : ''}`}>
                      {daysLabel(d.daysLeft)}
                    </span>
                  ) : (
                    <span className="state state-completed">chiusa</span>
                  )}
                </td>
                <td>{CATEGORY_LABELS[d.category]}</td>
                <td>
                  {d.title}
                  {d.notes && <div className="muted">{d.notes}</div>}
                </td>
                {canManage && (
                  <td>
                    {d.status === 'OPEN' &&
                      (closing === d.id ? (
                        <span className="actions">
                          <button
                            type="button"
                            disabled={close.isPending}
                            onClick={() => close.mutate(d.id)}
                          >
                            Conferma chiusura
                          </button>
                          <button type="button" className="link" onClick={() => setClosing(null)}>
                            Annulla
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setClosing(d.id)}
                        >
                          Chiudi
                        </button>
                      ))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {close.isError && (
        <p className="error" role="alert">
          {describeError(close.error)}
        </p>
      )}
      {canManage && <NewDeadlineForm />}
    </>
  );
}

function NewDeadlineForm() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<DeadlineCategory>('DURC');
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api('/compliance/deadlines', {
        method: 'POST',
        body: {
          category,
          title: title.trim(),
          dueDate,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      }),
    onSuccess: async () => {
      setTitle('');
      setDueDate('');
      setNotes('');
      await queryClient.invalidateQueries({ queryKey: ['deadlines'] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <form className="card form" onSubmit={submit} aria-labelledby="new-deadline">
      <h2 id="new-deadline">Nuova scadenza</h2>
      <label htmlFor="category">Categoria</label>
      <select
        id="category"
        value={category}
        onChange={(e) => setCategory(e.target.value as DeadlineCategory)}
      >
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
      <label htmlFor="title">Titolo</label>
      <input
        id="title"
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Es. DURC cooperativa"
      />
      <label htmlFor="due">Data di scadenza</label>
      <input id="due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      <label htmlFor="notes">Note (facoltative)</label>
      <input id="notes" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <p className="muted">
        Non inserire informazioni sanitarie: per le visite mediche basta la data.
      </p>
      <button type="submit" disabled={!title.trim() || !dueDate || create.isPending}>
        Aggiungi scadenza
      </button>
      {create.isError && (
        <p className="error" role="alert">
          {describeError(create.error)}
        </p>
      )}
      {create.isSuccess && <p role="status">Scadenza aggiunta: riceverai i promemoria.</p>}
    </form>
  );
}
