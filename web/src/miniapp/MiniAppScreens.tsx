import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { describeError, ROLE_LABELS, type Me } from '../api/client';
import {
  categoryLabel,
  deadlineWhen,
  describeFeed,
  feedTone,
  KIND_LABELS,
  greeting,
  monthName,
  plural,
  shortDate,
  weekdayName,
  weekOf,
  type MiniAppSummary,
} from '../api/miniapp';
import {
  STATE_LABELS,
  type DocumentChecklist,
  type DocumentRequest,
  type PracticeDetail,
} from '../api/practices';
import { useSession } from '../session/session';

import {
  ArrowIcon,
  BackIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  DocIcon,
  DocPlusIcon,
  FolderIcon,
  HomeIcon,
  Logo,
  MenuIcon,
  PlusIcon,
  Ring,
  UploadIcon,
} from './icons';

import type { SheetIntent } from './MiniApp';

export function useSummary(me: Me) {
  const { api } = useSession();
  return useQuery({
    queryKey: ['miniapp', me.current.orgId, 'summary'],
    queryFn: () => api<MiniAppSummary>('/miniapp/summary'),
  });
}

function Week({ summary, today }: { summary: MiniAppSummary | undefined; today: Date }) {
  const days = weekOf(today, summary?.deadlines ?? []);
  return (
    <nav className="ma-week" aria-label="Settimana">
      {days.map((d) => (
        <div
          key={d.iso}
          className={d.today ? 'today' : undefined}
          aria-current={d.today ? 'date' : undefined}
        >
          <small>{d.letter}</small>
          <span>{d.day}</span>
          {(d.hasDeadline || d.today) && <i aria-hidden="true" />}
        </div>
      ))}
    </nav>
  );
}

function Problem({ error }: { error: unknown }) {
  return (
    <p className="ma-message error" role="alert">
      {describeError(error)}
    </p>
  );
}

/** «Oggi»: the day, what waits for the person, the latest news. */
export function TodayScreen({ me, openSheet }: { me: Me; openSheet: (i: SheetIntent) => void }) {
  const query = useSummary(me);
  const s = query.data;
  const today = new Date();
  const org = me.organizations.find((o) => o.orgId === me.current.orgId);
  const week = (s?.deadlines ?? []).filter((d) => d.daysLeft <= 7);
  const overdue = (s?.deadlines ?? []).filter((d) => d.daysLeft < 0);
  const next = (s?.deadlines ?? []).find((d) => d.daysLeft >= 0);

  return (
    <>
      <header className="ma-head">
        <Ring percent={s?.documents.percent ?? null} />
        <h1>
          <span className="ma-day">{today.getDate()}</span>
          <span className="ma-weekday">{weekdayName(today)}</span>
        </h1>
        <Link to="/tg/agenda" className="ma-iconbtn ghost" aria-label="Agenda">
          <MenuIcon size={24} />
        </Link>
      </header>

      <Week summary={s} today={today} />

      <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p className="ma-org">
          <HomeIcon size={18} color="#e6eaef" />
          <strong>{org?.name ?? 'La tua organizzazione'}</strong>
          <span>· {ROLE_LABELS[me.current.role].toLowerCase()}</span>
        </p>
        {query.isError && <Problem error={query.error} />}
        {s && (
          <p className="ma-greeting">
            {greeting(today.getHours())}.
            <br />
            Hai{' '}
            <b>
              <CalendarIcon size={22} /> {plural(week.length, 'scadenza', 'scadenze')}
            </b>
            ,{' '}
            <b>
              <DocPlusIcon size={22} /> {plural(s.requests.length, 'documento', 'documenti')}
            </b>{' '}
            da mandare e{' '}
            <b>
              <FolderIcon size={22} /> {plural(s.practices.length, 'pratica', 'pratiche')}
            </b>{' '}
            in corso.
          </p>
        )}
        {s && (
          <div className="ma-chips">
            {overdue.length > 0 ? (
              <span className="ma-chip late">
                <ClockIcon size={16} color="#f87171" />
                {plural(overdue.length, 'scaduta', 'scadute')}
              </span>
            ) : (
              <span className="ma-chip ok">
                <CheckIcon size={16} color="#4ade80" />
                Nessuna scaduta
              </span>
            )}
            {next && (
              <span className="ma-chip warn">
                <ClockIcon size={16} color="#fbbf24" />
                {categoryLabel(next.category)} {deadlineWhen(next.daysLeft)}
              </span>
            )}
            {s.documents.percent !== null && (
              <span className="ma-chip info">
                <DocIcon size={16} color="#93c5fd" />
                Documenti {s.documents.percent}%
              </span>
            )}
          </div>
        )}
      </section>

      {s && s.feed.length > 0 && (
        <section className="ma-feed" aria-label="Novità">
          {s.feed.slice(0, 3).map((f, i) => {
            const line = describeFeed(f);
            return (
              <Link
                key={`${f.at}-${i}`}
                to={`/tg/pratiche/${f.practiceId}`}
                className="ma-feed-item"
                style={{ opacity: i === 2 ? 0.55 : 1 }}
              >
                <span className={`ma-tile ${feedTone(f.type)}`}>
                  {feedTone(f.type) === 'info' ? (
                    <FolderIcon size={22} color="#ffffff" />
                  ) : (
                    <DocIcon size={22} color="#ffffff" />
                  )}
                </span>
                <p>
                  <strong>{line.title}</strong> {line.text}
                </p>
              </Link>
            );
          })}
          <Link to="/tg/agenda" className="ma-pill">
            Apri attività
          </Link>
        </section>
      )}
      {s && s.feed.length === 0 && (
        <p className="ma-muted">Ancora nessuna novità sulle tue pratiche.</p>
      )}

      <button
        type="button"
        className="ma-fab"
        aria-label="Nuova azione"
        onClick={() => openSheet({ kind: 'menu' })}
      >
        <PlusIcon size={24} />
      </button>
    </>
  );
}

/** «Agenda»: the week, the documents, what is to do. */
export function AgendaScreen({ me, openSheet }: { me: Me; openSheet: (i: SheetIntent) => void }) {
  const query = useSummary(me);
  const s = query.data;
  const today = new Date();
  const week = (s?.deadlines ?? []).filter((d) => d.daysLeft <= 7);
  const firstRequest = s?.requests[0];
  const percent = s?.documents.percent ?? null;

  return (
    <>
      <div className="ma-panel">
        <header className="ma-panel-head">
          <Link to="/tg" className="ma-iconbtn" aria-label="Torna a Oggi">
            <BackIcon />
          </Link>
          <h1>
            {monthName(today)} <span className="ma-muted">{today.getFullYear()}</span>
          </h1>
          <Logo />
        </header>
        <Week summary={s} today={today} />
      </div>

      {query.isError && <Problem error={query.error} />}

      {s && (
        <>
          <div className="ma-bar">
            <span style={{ fontSize: 15, color: '#cbd3dc' }}>Documenti</span>
            <span className="ma-bar-track" aria-hidden="true">
              <span style={{ width: `${percent ?? 0}%` }} />
            </span>
            <strong style={{ fontSize: 20 }}>{percent === null ? '—' : `${percent}%`}</strong>
          </div>

          <section className="ma-week-summary">
            <h2>Questa settimana</h2>
            <p className="ma-big">
              <span>
                <CalendarIcon size={24} color="#aab4bf" />
                {plural(week.length, 'scadenza', 'scadenze')}
              </span>
              <span>
                <FolderIcon size={24} color="#aab4bf" />
                {plural(s.practices.length, 'pratica', 'pratiche')}
              </span>
            </p>
            {firstRequest && (
              <Link to={`/tg/pratiche/${firstRequest.practiceId}`} className="ma-outline">
                <ClockIcon size={16} color="#fbbf24" />
                {firstRequest.label ?? 'Documento richiesto'}
                {firstRequest.dueDate && (
                  <span className="ma-muted">entro il {shortDate(firstRequest.dueDate)}</span>
                )}
              </Link>
            )}
            {s.practices[0] && (
              <Link to={`/tg/pratiche/${s.practices[0].id}`} className="ma-outline green">
                <ArrowIcon size={16} color="#4ade80" />
                {s.practices[0].name}
                <span className="ma-muted">
                  {STATE_LABELS[s.practices[0].status].toLowerCase()}
                </span>
              </Link>
            )}
          </section>

          <section className="ma-list" aria-labelledby="ma-todo">
            <div className="ma-list-head">
              <h2 id="ma-todo">Da fare</h2>
              <span className="ma-muted">
                {s.requests.length + s.toConfirm.length + s.deadlines.length}
              </span>
            </div>
            {s.requests.map((r) => (
              <button
                key={r.id}
                type="button"
                className="ma-row"
                onClick={() =>
                  openSheet({ kind: 'upload', practiceId: r.practiceId, requestId: r.id })
                }
              >
                <span className="ma-tile small ask">
                  <UploadIcon size={17} color="#ffffff" />
                </span>
                <span className="ma-row-title">Manda: {r.label ?? r.message}</span>
                <span className="ma-row-when">
                  {r.dueDate ? `entro ${shortDate(r.dueDate)}` : r.practiceName}
                </span>
              </button>
            ))}
            {s.toConfirm.map((a) => (
              <Link key={a.attachmentId} to={`/tg/pratiche/${a.practiceId}`} className="ma-row">
                <span className="ma-tile small info">
                  <DocIcon size={17} color="#ffffff" />
                </span>
                <span className="ma-row-title">Controlla {a.fileName}</span>
                <span className="ma-row-when">da verificare</span>
              </Link>
            ))}
            {s.deadlines.map((d) => (
              <div key={d.id} className="ma-row">
                <span className="ma-tile small">
                  <CalendarIcon size={17} color="#ffffff" />
                </span>
                <span className="ma-row-title">{d.title}</span>
                <span className="ma-row-when">{deadlineWhen(d.daysLeft)}</span>
              </div>
            ))}
            {s.requests.length + s.toConfirm.length + s.deadlines.length === 0 && (
              <p className="ma-muted">Niente da fare: tutto in ordine.</p>
            )}
          </section>

          {s.practices.length > 0 && (
            <section className="ma-list" aria-labelledby="ma-practices">
              <div className="ma-list-head">
                <h2 id="ma-practices">Pratiche in corso</h2>
              </div>
              {s.practices.map((p) => (
                <Link key={p.id} to={`/tg/pratiche/${p.id}`} className="ma-row">
                  <span className="ma-tile small">
                    <FolderIcon size={17} color="#ffffff" />
                  </span>
                  <span className="ma-row-title">{p.name}</span>
                  <span className="ma-row-when">
                    {p.documents.expected > 0
                      ? `${p.documents.confirmed}/${p.documents.expected} doc.`
                      : STATE_LABELS[p.status].toLowerCase()}
                  </span>
                </Link>
              ))}
            </section>
          )}
        </>
      )}

      <button
        type="button"
        className="ma-fab round"
        aria-label="Nuova azione"
        onClick={() => openSheet({ kind: 'menu' })}
      >
        <PlusIcon size={24} />
      </button>
    </>
  );
}

const STEP_DOT = { ok: '#4ade80', ask: '#fbbf24', bad: '#f87171', info: '#93c5fd' } as const;

const DOC_STATES: Record<DocumentChecklist['items'][number]['state'], string> = {
  valid: 'confermato',
  to_verify: 'da verificare',
  missing: 'manca',
  rejected: 'da rifare',
};

/** «Pratica»: its documents, what is asked for, the latest steps. */
export function PracticeScreen({ me, openSheet }: { me: Me; openSheet: (i: SheetIntent) => void }) {
  const { id = '' } = useParams();
  const { api } = useSession();
  const practice = useQuery({
    queryKey: ['practice', id],
    queryFn: () => api<PracticeDetail>(`/practices/${id}`),
  });
  const checklist = useQuery({
    queryKey: ['checklist', id],
    queryFn: () => api<DocumentChecklist>(`/practices/${id}/checklist`),
  });
  const requests = useQuery({
    queryKey: ['document-requests', id],
    queryFn: () => api<DocumentRequest[]>(`/practices/${id}/document-requests`),
  });
  const summary = useSummary(me);
  const p = practice.data;
  const items = checklist.data?.items ?? [];
  const open = (requests.data ?? []).filter((r) => r.status === 'OPEN');
  const steps = (summary.data?.feed ?? []).filter((f) => f.practiceId === id);
  const done = items.filter((i) => i.state === 'valid').length;
  const closed = p?.status === 'COMPLETED' || p?.status === 'FAILED';

  return (
    <>
      <header className="ma-head">
        <Link to="/tg/agenda" className="ma-iconbtn" aria-label="Indietro">
          <BackIcon />
        </Link>
        <span className="ma-muted" style={{ fontSize: 15 }}>
          {p ? (KIND_LABELS[p.kind] ?? 'Pratica') : 'Pratica'}
        </span>
      </header>
      {practice.isError && <Problem error={practice.error} />}
      {p && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h1 style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.15 }}>{p.name}</h1>
          <div className="ma-tags">
            <span className="ma-tag">{STATE_LABELS[p.status]}</span>
          </div>
        </section>
      )}

      {items.length > 0 && (
        <section className="ma-card" aria-labelledby="ma-docs">
          <div className="ma-list-head">
            <h2 id="ma-docs">Documenti</h2>
            <span className="ma-muted">
              <strong style={{ color: '#f3f5f7' }}>{done}</strong> su {items.length}
            </span>
          </div>
          <div className="ma-segments" aria-hidden="true">
            {items.map((i) => (
              <span key={i.key} className={i.state} />
            ))}
          </div>
          <ul className="ma-docs">
            {items.map((i) => (
              <li key={i.key}>
                <span className={`ma-check ${i.state}`} aria-hidden="true">
                  {i.state === 'valid' && <CheckIcon size={14} color="#052e16" />}
                </span>
                <span>{i.label}</span>
                <span className={`ma-state ${i.state}`}>{DOC_STATES[i.state]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {open.map((r) => (
        <section key={r.id} className="ma-request" aria-label="Documento richiesto">
          <p className="ma-request-head">
            <ClockIcon size={16} />
            {r.expectedLabel ?? 'Documento richiesto'}
            {r.dueDate && ` · entro il ${shortDate(r.dueDate)}`}
          </p>
          <p>{r.message}</p>
          <button
            type="button"
            className="ma-primary"
            onClick={() => openSheet({ kind: 'upload', practiceId: id, requestId: r.id })}
          >
            <UploadIcon size={18} />
            Manda il documento
          </button>
        </section>
      ))}

      {p && !closed && open.length === 0 && (
        <button
          type="button"
          className="ma-primary green"
          onClick={() => openSheet({ kind: 'upload', practiceId: id })}
        >
          <UploadIcon size={18} />
          Aggiungi un documento
        </button>
      )}

      {steps.length > 0 && (
        <section
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          aria-labelledby="ma-steps"
        >
          <h2 id="ma-steps" className="ma-muted" style={{ fontSize: 15, fontWeight: 500 }}>
            Ultimi passi
          </h2>
          {steps.map((f, i) => {
            const line = describeFeed(f);
            return (
              <p
                key={`${f.at}-${i}`}
                style={{ display: 'flex', gap: 10, fontSize: 15, color: '#b8c2cc' }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    marginTop: 6,
                    flex: 'none',
                    borderRadius: 4,
                    background: STEP_DOT[feedTone(f.type)],
                  }}
                />
                <span>
                  <span style={{ color: '#f3f5f7' }}>{line.title}</span> {line.text} ·{' '}
                  {shortDate(f.at.slice(0, 10))}
                </span>
              </p>
            );
          })}
        </section>
      )}
    </>
  );
}
