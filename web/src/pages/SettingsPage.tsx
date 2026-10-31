import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';

import { describeError, type Me } from '../api/client';
import {
  FREQUENCY_LABELS,
  ORGANIZATION_TYPE_LABELS,
  type Frequency,
  type Settings,
} from '../api/organization';
import { useSession } from '../session/session';

const FREQUENCIES = Object.keys(FREQUENCY_LABELS) as Frequency[];

/** P12: name and scheduled export of the organization; administrators only. */
export function SettingsPage({ me }: { me: Me }) {
  const { api, refreshMe } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = me.current.role === 'ADMIN';
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState<Frequency>('monthly');

  const query = useQuery({
    queryKey: ['organization', me.current.orgId],
    queryFn: () => api<Settings>('/organization'),
    enabled: isAdmin,
  });

  // The form starts from what is saved, and again after every save.
  useEffect(() => {
    if (!query.data) return;
    setName(query.data.name);
    setEnabled(query.data.scheduledExport.enabled);
    setFrequency(query.data.scheduledExport.frequency);
  }, [query.data]);

  const save = useMutation({
    mutationFn: () =>
      api<Settings>('/organization', {
        method: 'PATCH',
        body: { name: name.trim(), scheduledExport: { enabled, frequency } },
      }),
    onSuccess: async (data) => {
      queryClient.setQueryData(['organization', me.current.orgId], data);
      // The name is also in the header and in the choice of the organization.
      await refreshMe();
    },
  });

  if (!isAdmin) {
    return (
      <>
        <h1>Impostazioni</h1>
        <p className="muted">
          Solo gli amministratori modificano le impostazioni dell&apos;azienda.
        </p>
      </>
    );
  }

  const saved = query.data;
  const changed =
    saved !== undefined &&
    (name.trim() !== saved.name ||
      enabled !== saved.scheduledExport.enabled ||
      frequency !== saved.scheduledExport.frequency);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <>
      <h1>Impostazioni</h1>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {saved && (
        <form className="card form" onSubmit={submit} aria-labelledby="settings-title">
          <h2 id="settings-title">Organizzazione</h2>
          <label htmlFor="org-name">Nome</label>
          <input
            id="org-name"
            maxLength={120}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              save.reset();
            }}
          />
          <p>
            <strong>Tipo:</strong> {ORGANIZATION_TYPE_LABELS[saved.type]}{' '}
            <span className="muted">(lo cambia solo il gestore della piattaforma)</span>
          </p>

          <fieldset className="plain-fieldset">
            <legend>Export pianificato delle pratiche</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  setEnabled(e.target.checked);
                  save.reset();
                }}
              />
              Attivo
            </label>
            <label htmlFor="org-frequency">Frequenza</label>
            <select
              id="org-frequency"
              value={frequency}
              disabled={!enabled}
              onChange={(e) => {
                setFrequency(e.target.value as Frequency);
                save.reset();
              }}
            >
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {FREQUENCY_LABELS[f]}
                </option>
              ))}
            </select>
            <p className="muted">
              Il file arriva in chat solo agli amministratori che lo hanno scelto nella pagina
              Persone. Se cambi la frequenza, il prossimo invio può arrivare prima del solito.
            </p>
          </fieldset>

          <p>
            <strong>Promemoria delle scadenze:</strong> sempre attivi,{' '}
            {saved.reminderDays.join(', ')} giorni prima e il giorno stesso.
          </p>

          <button type="submit" disabled={!changed || name.trim().length < 2 || save.isPending}>
            Salva
          </button>
          {save.isError && (
            <p className="error" role="alert">
              {describeError(save.error)}
            </p>
          )}
          {save.isSuccess && <p role="status">Impostazioni salvate.</p>}
        </form>
      )}
    </>
  );
}
