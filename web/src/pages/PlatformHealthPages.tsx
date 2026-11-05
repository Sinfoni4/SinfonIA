import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { describeError } from '../api/client';
import {
  formatBytes,
  formatNumber,
  formatUptime,
  healthWarnings,
  MODE_LABELS,
  OUTCOME_LABELS,
  USAGE_PERIODS,
  type AiUsage,
  type SystemHealth,
  type UsagePeriod,
} from '../api/health';
import { formatDateTime } from '../api/organization';
import { formatDate } from '../api/practices';
import { useSession } from '../session/session';

const configured = (on: boolean) => (on ? 'configurato' : 'non configurato');

/** A5 / FE8: the state of the system, refreshed every minute. */
export function HealthPage() {
  const { api } = useSession();
  const query = useQuery({
    queryKey: ['platform', 'health'],
    queryFn: () => api<SystemHealth>('/platform/health'),
    refetchInterval: 60_000,
  });
  const h = query.data;
  const warnings = h ? healthWarnings(h) : [];

  return (
    <>
      <div className="page-head">
        <h1>Salute del sistema</h1>
        <button
          type="button"
          className="secondary"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Aggiorna
        </button>
      </div>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {h && (
        <>
          {warnings.length > 0 ? (
            <ul className="error" role="alert">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : (
            <p className="notice" role="status">
              Tutto funziona regolarmente.
            </p>
          )}
          <section className="card">
            <h2>Database e servizio</h2>
            <dl className="facts">
              <dt>Database</dt>
              <dd>
                {h.database.reachable
                  ? `raggiungibile (${h.database.latencyMs ?? '—'} ms), modo ${
                      MODE_LABELS[h.database.mode] ?? h.database.mode
                    }`
                  : 'non raggiungibile'}
              </dd>
              <dt>Attivo da</dt>
              <dd>{formatUptime(h.process.uptimeSeconds)}</dd>
              <dt>Memoria</dt>
              <dd>{h.process.memoryMb} MB</dd>
              <dt>Node.js</dt>
              <dd>{h.process.node}</dd>
              <dt>Controllato</dt>
              <dd>{formatDateTime(h.checkedAt)}</dd>
            </dl>
          </section>
          <section className="card">
            <h2>Consegne (avvisi, promemoria, export)</h2>
            <dl className="facts">
              <dt>Da consegnare</dt>
              <dd>
                {h.outbox.pending}
                {h.outbox.oldestPendingMinutes !== null &&
                  ` (il più vecchio da ${h.outbox.oldestPendingMinutes} min)`}
              </dd>
              <dt>In consegna</dt>
              <dd>{h.outbox.processing}</dd>
              <dt>Da ritentare</dt>
              <dd>{h.outbox.failed}</dd>
              <dt>Non consegnati</dt>
              <dd>
                {h.outbox.deadLetter} in tutto, {h.outbox.deadLetterLast24h} nelle ultime 24 ore
              </dd>
            </dl>
          </section>
          <section className="card">
            <h2>Attività pianificate</h2>
            <dl className="facts">
              <dt>Ultima esecuzione</dt>
              <dd>{h.scheduler.lastRunAt ? formatDateTime(h.scheduler.lastRunAt) : 'mai'}</dd>
              <dt>Ultime 24 ore</dt>
              <dd>
                {h.scheduler.runsLast24h} esecuzioni, {h.scheduler.failedLast24h} non riuscite
              </dd>
            </dl>
          </section>
          {h.documents && (
            <section className="card">
              <h2>Lettura dei documenti</h2>
              <dl className="facts">
                <dt>Da leggere</dt>
                <dd>
                  {h.documents.pending}
                  {h.documents.oldestPendingMinutes !== null &&
                    ` (il più vecchio da ${h.documents.oldestPendingMinutes} min)`}
                </dd>
                <dt>In lettura</dt>
                <dd>{h.documents.processing}</dd>
                <dt>Non letti nelle ultime 24 ore</dt>
                <dd>{h.documents.failedLast24h}</dd>
              </dl>
            </section>
          )}
          {h.storage && (
            <section className="card">
              <h2>Archivio degli allegati</h2>
              <dl className="facts">
                <dt>Allegati</dt>
                <dd>
                  {formatNumber(h.storage.attachments)}, {formatBytes(h.storage.bytes)}
                </dd>
                <dt>Archivio</dt>
                <dd>
                  {h.storage.driver === 'local' ? 'disco del server' : 'archivio esterno (S3)'}
                </dd>
                {h.storage.disk && (
                  <>
                    <dt>File sul disco</dt>
                    <dd>{formatNumber(h.storage.disk.files)}</dd>
                    <dt>File orfani</dt>
                    <dd>
                      {formatNumber(h.storage.disk.orphanFiles)}
                      {h.storage.disk.orphanFiles > 0 && ' (elenco con npm run storage:orphans)'}
                    </dd>
                    <dt>Allegati senza file</dt>
                    <dd>{formatNumber(h.storage.disk.missingFiles)}</dd>
                    <dt>Controllo del disco</dt>
                    <dd>{formatDateTime(h.storage.disk.checkedAt)}</dd>
                  </>
                )}
              </dl>
            </section>
          )}
          {h.backup && (
            <section className="card">
              <h2>Backup</h2>
              <dl className="facts">
                <dt>Cartella dei backup</dt>
                <dd>
                  {!h.backup.configured
                    ? 'non configurata su questo server'
                    : h.backup.reachable
                      ? 'raggiungibile'
                      : 'non raggiungibile'}
                </dd>
                {h.backup.configured && h.backup.reachable && (
                  <>
                    <dt>Ultimo backup</dt>
                    <dd>
                      {h.backup.last
                        ? `${formatDateTime(h.backup.last.at)}${
                            h.backup.last.tables !== null ? `, ${h.backup.last.tables} tabelle` : ''
                          }${
                            h.backup.last.attachments !== null
                              ? `, ${h.backup.last.attachments} allegati`
                              : ''
                          }`
                        : 'nessuno'}
                    </dd>
                    <dt>Verifica del ripristino</dt>
                    <dd>
                      {h.backup.restoreCheck
                        ? `${h.backup.restoreCheck.ok ? 'riuscita' : 'NON riuscita'} il ${formatDateTime(
                            h.backup.restoreCheck.at,
                          )} (backup del ${formatDateTime(h.backup.restoreCheck.backupAt)})`
                        : 'mai fatta'}
                    </dd>
                  </>
                )}
              </dl>
            </section>
          )}
          <section className="card">
            <h2>Servizi collegati</h2>
            <dl className="facts">
              <dt>Telegram</dt>
              <dd>{configured(h.services.telegram)}</dd>
              <dt>WhatsApp</dt>
              <dd>{configured(h.services.whatsapp)}</dd>
              <dt>Webhook</dt>
              <dd>{configured(h.services.webhook)}</dd>
              <dt>Intelligenza artificiale</dt>
              <dd>{h.services.ai ? `attiva (${h.services.ai})` : 'spenta'}</dd>
            </dl>
          </section>
        </>
      )}
    </>
  );
}

/** A5 / FE8: use of the AI by organization, day, model and outcome; counts only. */
export function AiUsagePage() {
  const { api } = useSession();
  const [days, setDays] = useState<UsagePeriod>(7);
  const query = useQuery({
    queryKey: ['platform', 'ai-usage', days],
    queryFn: () => api<AiUsage>(`/platform/ai-usage?days=${days}`),
    placeholderData: keepPreviousData,
  });
  const u = query.data;

  return (
    <>
      <div className="page-head">
        <h1>Consumi IA</h1>
        <nav className="tabs" aria-label="Periodo">
          {USAGE_PERIODS.map((d) => (
            <button
              key={d}
              type="button"
              className={`link ${days === d ? 'active' : ''}`}
              aria-pressed={days === d}
              onClick={() => setDays(d)}
            >
              {d === 1 ? 'Ultime 24 ore' : `Ultimi ${d} giorni`}
            </button>
          ))}
        </nav>
      </div>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {u && u.totals.requests === 0 && (
        <p className="muted">Nessuna richiesta all&apos;IA nel periodo.</p>
      )}
      {u && u.totals.requests > 0 && (
        <>
          <section className="card">
            <dl className="facts">
              <dt>Richieste</dt>
              <dd>{formatNumber(u.totals.requests)}</dd>
              <dt>Token</dt>
              <dd>{formatNumber(u.totals.tokens)}</dd>
              <dt>Errori del servizio</dt>
              <dd>{formatNumber(u.totals.errors)}</dd>
              <dt>Tempo medio di risposta</dt>
              <dd>
                {u.totals.averageLatencyMs === null
                  ? '—'
                  : `${formatNumber(u.totals.averageLatencyMs)} ms`}
              </dd>
            </dl>
          </section>
          <UsageTable
            title="Per organizzazione"
            head={['Organizzazione', 'Richieste', 'Token', 'Errori']}
            rows={u.byOrganization.map((o) => [
              o.name,
              formatNumber(o.requests),
              formatNumber(o.tokens),
              formatNumber(o.errors),
            ])}
          />
          <UsageTable
            title="Per giorno"
            head={['Giorno', 'Richieste', 'Token', 'Errori']}
            rows={u.byDay.map((d) => [
              formatDate(d.day),
              formatNumber(d.requests),
              formatNumber(d.tokens),
              formatNumber(d.errors),
            ])}
          />
          <UsageTable
            title="Per modello"
            head={['Modello', 'Richieste', 'Token']}
            rows={u.byModel.map((m) => [
              `${m.model} (${m.provider})`,
              formatNumber(m.requests),
              formatNumber(m.tokens),
            ])}
          />
          <UsageTable
            title="Per esito"
            head={['Esito', 'Richieste']}
            rows={u.byOutcome.map((o) => [
              OUTCOME_LABELS[o.outcome] ?? o.outcome,
              formatNumber(o.requests),
            ])}
          />
        </>
      )}
      <p className="muted">
        Solo conteggi: le richieste e le risposte dell&apos;IA non vengono conservate.
      </p>
    </>
  );
}

function UsageTable({ title, head, rows }: { title: string; head: string[]; rows: string[][] }) {
  if (rows.length === 0) return null;
  return (
    <section className="card">
      <h2>{title}</h2>
      <table className="list cards">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r[0]}-${i}`}>
              {r.map((cell, j) => (
                <td key={head[j]} data-label={head[j]}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
