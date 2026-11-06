import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { describeError, type Me } from '../api/client';
import { FALLBACK_MODULE, fieldValues, type CurrentModule } from '../api/modules';
import { holderLabel, type HolderCandidate, type Practice } from '../api/practices';
import { useSession } from '../session/session';

/**
 * P5: a new practice; kinds and fields come from the module (A02). AGX-03: administrators and
 * operators may open it for another person of the organization, its holder.
 */
export function NewPracticePage({ me }: { me: Me }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [chosenKind, setKind] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [holder, setHolder] = useState('');
  const staff = me.current.role !== 'MEMBER';
  // Refused for a custom role without `practice.assign`: then the choice is simply not shown.
  const holders = useQuery({
    queryKey: ['holders', me.current.orgId],
    queryFn: () => api<HolderCandidate[]>('/practices/holders'),
    enabled: staff,
    retry: false,
  });
  const others = (holders.data ?? []).filter((c) => c.userId !== me.userId);

  const moduleQuery = useQuery({
    queryKey: ['module'],
    queryFn: () => api<CurrentModule>('/modules/current'),
    retry: false,
  });
  const module = moduleQuery.data ?? FALLBACK_MODULE;
  const kind = chosenKind ?? module.defaultKind;
  const type = module.practiceTypes.find((t) => t.kind === kind) ?? module.practiceTypes[0];

  const create = useMutation({
    mutationFn: () => {
      const fields = fieldValues(type, values);
      return api<Practice>('/practices', {
        method: 'POST',
        body: {
          name: name.trim(),
          kind: type.kind,
          ...(Object.keys(fields).length > 0 ? { fields } : {}),
          ...(holder ? { holderUserId: holder } : {}),
        },
      });
    },
    onSuccess: async (practice) => {
      await queryClient.invalidateQueries({ queryKey: ['practices'] });
      await navigate(`/pratiche/${practice.id}`);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  const missing = type.fields.some((f) => f.required && !values[f.key]?.trim());

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
        {others.length > 0 && (
          <>
            <label htmlFor="holder">Aperta per</label>
            <select id="holder" value={holder} onChange={(e) => setHolder(e.target.value)}>
              <option value="">Me stesso</option>
              {others.map((c) => (
                <option key={c.userId} value={c.userId}>
                  {holderLabel(c)}
                </option>
              ))}
            </select>
            {holder && (
              <p className="muted">
                La persona vedrà la pratica, potrà inviare i documenti e riceverà gli avvisi.
              </p>
            )}
          </>
        )}
        <label htmlFor="kind">Tipo</label>
        <select
          id="kind"
          value={type.kind}
          onChange={(e) => {
            setKind(e.target.value);
            setValues({});
          }}
        >
          {module.practiceTypes.map((t) => (
            <option key={t.kind} value={t.kind}>
              {t.label}
            </option>
          ))}
        </select>
        {type.fields.map((field) => {
          const id = `field-${field.key}`;
          const set = (value: string) => setValues((v) => ({ ...v, [field.key]: value }));
          return (
            <div key={field.key} className="form">
              <label htmlFor={id}>
                {field.label}
                {field.required ? '' : ' (facoltativo)'}
              </label>
              {field.type === 'choice' ? (
                <select
                  id={id}
                  value={values[field.key] ?? ''}
                  onChange={(e) => set(e.target.value)}
                >
                  <option value="">—</option>
                  {field.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  type={field.type === 'text' ? 'text' : field.type}
                  maxLength={field.type === 'text' ? (field.maxLength ?? 200) : undefined}
                  min={field.min}
                  max={field.max}
                  value={values[field.key] ?? ''}
                  onChange={(e) => set(e.target.value)}
                />
              )}
            </div>
          );
        })}
        {type.expectedDocuments.length > 0 && (
          <p className="muted">
            Documenti di solito necessari:{' '}
            {type.expectedDocuments
              .map((d) => `${d.label}${d.required ? '' : ' (se c’è)'}`)
              .join(', ')}
            .
          </p>
        )}
        <button type="submit" disabled={!name.trim() || missing || create.isPending}>
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
