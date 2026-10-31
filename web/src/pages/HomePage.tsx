import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { describeError, ROLE_LABELS, type Me } from '../api/client';
import { CATEGORY_LABELS, daysLabel, isoToItalian } from '../api/compliance';
import {
  actorLabel,
  auditQuery,
  describeEvent,
  formatDateTime,
  openPractices,
  type AuditPage,
  type Summary,
} from '../api/organization';
import { formatDate, STATE_LABELS } from '../api/practices';
import { useSession } from '../session/session';

/**
 * P11: the numbers of the organization (G7): practices in progress, overdue and upcoming
 * deadlines, documents to check, latest practices; for administrators also the latest activity.
 * A MEMBER sees only their own.
 */
export function HomePage({ me }: { me: Me }) {
  const { api } = useSession();
  const current = me.organizations.find((o) => o.orgId === me.current.orgId);
  const isAdmin = me.current.role === 'ADMIN';
  const own = me.current.role === 'MEMBER';

  const summary = useQuery({
    queryKey: ['summary', me.current.orgId],
    queryFn: () => api<Summary>('/dashboard/summary'),
  });
  const activity = useQuery({
    queryKey: ['audit', me.current.orgId, 'home'],
    queryFn: () => api<AuditPage>(auditQuery({ page: 1, group: '', from: '', to: '', limit: 10 })),
    enabled: isAdmin,
  });
  const s = summary.data;

  return (
    <>
      <h1>{current?.name}</h1>
      <p className="muted">
        Accesso come {ROLE_LABELS[me.current.role]}
        {own ? ': qui vedi le tue pratiche e le tue scadenze.' : '.'}
      </p>
      {summary.isError && (
        <p className="error" role="alert">
          {describeError(summary.error)}
        </p>
      )}
      {summary.isPending && <p className="muted">Caricamento…</p>}
      {s && (
        <>
          <ul className="kpis" aria-label="Indicatori">
            <li className="card">
              <Link to="/pratiche">
                <strong>{openPractices(s)}</strong> pratiche in corso
              </Link>
              <span className="muted">
                {s.practices.byStatus.COMPLETED} completate · {s.practices.byStatus.FAILED} non
                riuscite
              </span>
            </li>
            <li className={`card ${s.deadlines.overdue > 0 ? 'alert' : ''}`}>
              <Link to="/scadenze">
                <strong>{s.deadlines.overdue}</strong>{' '}
                {s.deadlines.overdue === 1 ? 'scadenza scaduta' : 'scadenze scadute'}
              </Link>
              <span className="muted">{s.deadlines.dueSoon} nei prossimi 30 giorni</span>
            </li>
            <li
              className={`card ${s.documents.toReview + s.documents.unreadable > 0 ? 'warn' : ''}`}
            >
              <span>
                <strong>{s.documents.toReview + s.documents.unreadable}</strong> documenti da
                controllare
              </span>
              <span className="muted">
                {s.documents.toReview} da verificare · {s.documents.unreadable} non letti
              </span>
            </li>
          </ul>

          <div className="panels">
            <section className="card" aria-labelledby="home-deadlines">
              <h2 id="home-deadlines">Prossime scadenze</h2>
              {s.deadlines.upcoming.length === 0 ? (
                <p className="muted">Nessuna scadenza nei prossimi 30 giorni.</p>
              ) : (
                <ul className="plain">
                  {s.deadlines.upcoming.map((d) => (
                    <li key={d.id}>
                      <span className={`state ${d.daysLeft < 0 ? 'state-failed' : ''}`}>
                        {daysLabel(d.daysLeft)}
                      </span>{' '}
                      {d.title}
                      <div className="muted">
                        {CATEGORY_LABELS[d.category]} · {isoToItalian(d.dueDate)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <Link to="/scadenze">Tutte le scadenze</Link>
            </section>

            <section className="card" aria-labelledby="home-documents">
              <h2 id="home-documents">Documenti da controllare</h2>
              {s.documents.items.length === 0 ? (
                <p className="muted">Nessun documento da controllare.</p>
              ) : (
                <ul className="plain">
                  {s.documents.items.map((doc) => (
                    <li key={doc.attachmentId}>
                      <Link to={`/pratiche/${doc.practiceId}`}>{doc.fileName}</Link>
                      <div className="muted">
                        {doc.practiceName} ·{' '}
                        {doc.reason === 'unreadable' ? 'non letto' : 'dati da verificare'}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card" aria-labelledby="home-practices">
              <h2 id="home-practices">Ultime pratiche</h2>
              {s.recentPractices.length === 0 ? (
                <p className="muted">Ancora nessuna pratica.</p>
              ) : (
                <ul className="plain">
                  {s.recentPractices.map((p) => (
                    <li key={p.id}>
                      <Link to={`/pratiche/${p.id}`}>{p.name}</Link>
                      <div className="muted">
                        {STATE_LABELS[p.status]} · {formatDate(p.updatedAt)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <Link to="/pratiche">Tutte le pratiche</Link>
            </section>

            {isAdmin && (
              <section className="card" aria-labelledby="home-activity">
                <h2 id="home-activity">Ultime attività</h2>
                {activity.isError && (
                  <p className="error" role="alert">
                    {describeError(activity.error)}
                  </p>
                )}
                {activity.data && activity.data.items.length === 0 && (
                  <p className="muted">Nessuna attività registrata.</p>
                )}
                {activity.data && activity.data.items.length > 0 && (
                  <ul className="plain">
                    {activity.data.items.map((e) => (
                      <li key={e.id}>
                        {describeEvent(e)}
                        <div className="muted">
                          {formatDateTime(e.at)} · {actorLabel(e)}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <Link to="/attivita">Tutto il registro</Link>
              </section>
            )}
          </div>
        </>
      )}
    </>
  );
}
