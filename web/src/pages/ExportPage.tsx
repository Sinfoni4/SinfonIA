import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { describeError, type Me } from '../api/client';
import { exportFileName, type ExportFilter, type ExportResult } from '../api/compliance';
import { useSession } from '../session/session';

type Period = 'all' | 'today' | 'month' | 'year';

/**
 * P7: practices as CSV, for the period chosen. The perimeter is the backend's (D5): the whole
 * organization for an ADMIN, one's own practices otherwise unless an ADMIN granted more. Every
 * export is recorded in the audit with channel "web".
 */
export function ExportPage({ me }: { me: Me }) {
  const { api } = useSession();
  const [period, setPeriod] = useState<Period>('month');
  const [year, setYear] = useState(new Date().getFullYear());

  const run = useMutation({
    mutationFn: () => {
      const filter: ExportFilter =
        period === 'year' ? { type: 'year', value: year } : { type: period };
      return api<ExportResult>('/practices/export', { method: 'POST', body: { filter } });
    },
    onSuccess: (result) => {
      if (result.count === 0) return;
      const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFileName(result.title);
      link.click();
      URL.revokeObjectURL(url);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    run.mutate();
  };

  return (
    <>
      <h1>Export</h1>
      <p className="muted">
        {me.current.role === 'ADMIN'
          ? "Esporta le pratiche dell'azienda in un file CSV (nome e data di creazione)."
          : "Esporta in un file CSV (nome e data di creazione) le tue pratiche, oppure quelle dell'azienda se un amministratore te lo ha consentito."}{' '}
        Ogni export viene registrato.
      </p>
      <form className="card form" onSubmit={submit}>
        <fieldset className="plain-fieldset">
          <legend>Periodo</legend>
          {(
            [
              ['month', 'Questo mese'],
              ['today', 'Oggi'],
              ['year', 'Anno'],
              ['all', 'Tutte'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="radio">
              <input
                type="radio"
                name="period"
                value={value}
                checked={period === value}
                onChange={() => setPeriod(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {period === 'year' && (
          <>
            <label htmlFor="year">Anno</label>
            <input
              id="year"
              type="number"
              min={2000}
              max={2100}
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            />
          </>
        )}
        <button type="submit" disabled={run.isPending}>
          Scarica CSV
        </button>
        {run.isError && (
          <p className="error" role="alert">
            {describeError(run.error)}
          </p>
        )}
        {run.data && (
          <p role="status">
            {run.data.count === 0
              ? 'Nessuna pratica nel periodo scelto.'
              : `${run.data.title}: ${run.data.count} ${run.data.count === 1 ? 'pratica esportata' : 'pratiche esportate'}.`}
          </p>
        )}
      </form>
    </>
  );
}
