import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { describeError } from '../api/client';
import { KIND_LABELS, type Practice, type PracticeKind } from '../api/practices';
import { useSession } from '../session/session';

/** P5: a new practice, owned by whoever creates it. */
export function NewPracticePage() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PracticeKind>('generic');

  const create = useMutation({
    mutationFn: () =>
      api<Practice>('/practices', { method: 'POST', body: { name: name.trim(), kind } }),
    onSuccess: async (practice) => {
      await queryClient.invalidateQueries({ queryKey: ['practices'] });
      await navigate(`/pratiche/${practice.id}`);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <>
      <p>
        <Link to="/pratiche">← Pratiche</Link>
      </p>
      <h1>Nuova pratica</h1>
      <form className="card form" onSubmit={submit}>
        <label htmlFor="name">Nome</label>
        <input
          id="name"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Es. Mario Rossi"
        />
        <label htmlFor="kind">Tipo</label>
        <select id="kind" value={kind} onChange={(e) => setKind(e.target.value as PracticeKind)}>
          {(Object.keys(KIND_LABELS) as PracticeKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!name.trim() || create.isPending}>
          Crea pratica
        </button>
        {create.isError && (
          <p className="error" role="alert">
            {describeError(create.error)}
          </p>
        )}
      </form>
    </>
  );
}
