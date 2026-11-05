import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, FileSearch, FolderOpen } from 'lucide-react';
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

import type * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

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

  const toCheck = s ? s.documents.toReview + s.documents.unreadable : 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="m-0">{current?.name}</h1>
        <p className="m-0 text-sm text-muted-foreground">
          Accesso come {ROLE_LABELS[me.current.role]}
          {own ? ': qui vedi le tue pratiche e le tue scadenze.' : '.'}
        </p>
      </div>
      {summary.isError && (
        <p className="error m-0" role="alert">
          {describeError(summary.error)}
        </p>
      )}
      {summary.isPending && <p className="m-0 text-muted-foreground">Caricamento…</p>}
      {s && (
        <>
          <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-3" aria-label="Indicatori">
            <Kpi
              to="/pratiche"
              icon={<FolderOpen aria-hidden />}
              value={openPractices(s)}
              label="pratiche in corso"
              detail={`${s.practices.byStatus.COMPLETED} completate · ${s.practices.byStatus.FAILED} non riuscite`}
            />
            <Kpi
              to="/scadenze"
              icon={<CalendarClock aria-hidden />}
              value={s.deadlines.overdue}
              label={s.deadlines.overdue === 1 ? 'scadenza scaduta' : 'scadenze scadute'}
              detail={`${s.deadlines.dueSoon} nei prossimi 30 giorni`}
              tone={s.deadlines.overdue > 0 ? 'alert' : undefined}
            />
            <Kpi
              to="/verifica"
              icon={<FileSearch aria-hidden />}
              value={toCheck}
              label="documenti da controllare"
              detail={`${s.documents.toReview} da verificare · ${s.documents.unreadable} non letti`}
              tone={toCheck > 0 ? 'warn' : undefined}
            />
          </ul>

          <div className="grid items-start gap-3 md:grid-cols-2 lg:grid-cols-3">
            <Panel
              id="home-deadlines"
              title="Prossime scadenze"
              more={{ to: '/scadenze', label: 'Tutte le scadenze' }}
            >
              {s.deadlines.upcoming.length === 0 ? (
                <Empty>Nessuna scadenza nei prossimi 30 giorni.</Empty>
              ) : (
                <Rows>
                  {s.deadlines.upcoming.map((d) => (
                    <li key={d.id} className="flex flex-col gap-1 py-2">
                      <span className="flex items-center gap-2">
                        <Badge variant={d.daysLeft < 0 ? 'warning' : 'secondary'}>
                          {daysLabel(d.daysLeft)}
                        </Badge>
                        <span className="font-medium">{d.title}</span>
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {CATEGORY_LABELS[d.category]} · {isoToItalian(d.dueDate)}
                      </span>
                    </li>
                  ))}
                </Rows>
              )}
            </Panel>

            <Panel
              id="home-documents"
              title="Documenti da controllare"
              more={{ to: '/verifica', label: 'Apri «Da verificare»' }}
            >
              {s.documents.items.length === 0 ? (
                <Empty>Nessun documento da controllare.</Empty>
              ) : (
                <Rows>
                  {s.documents.items.map((doc) => (
                    <li key={doc.attachmentId} className="flex flex-col gap-0.5 py-2">
                      <Link to={`/pratiche/${doc.practiceId}`} className="truncate">
                        {doc.fileName}
                      </Link>
                      <span className="text-sm text-muted-foreground">
                        {doc.practiceName} ·{' '}
                        {doc.reason === 'unreadable' ? 'non letto' : 'dati da verificare'}
                      </span>
                    </li>
                  ))}
                </Rows>
              )}
            </Panel>

            <Panel
              id="home-practices"
              title="Ultime pratiche"
              more={{ to: '/pratiche', label: 'Tutte le pratiche' }}
            >
              {s.recentPractices.length === 0 ? (
                <Empty>Ancora nessuna pratica.</Empty>
              ) : (
                <Rows>
                  {s.recentPractices.map((p) => (
                    <li key={p.id} className="flex flex-col gap-0.5 py-2">
                      <Link to={`/pratiche/${p.id}`}>{p.name}</Link>
                      <span className="text-sm text-muted-foreground">
                        {STATE_LABELS[p.status]} · {formatDate(p.updatedAt)}
                      </span>
                    </li>
                  ))}
                </Rows>
              )}
            </Panel>

            {isAdmin && (
              <Panel
                id="home-activity"
                title="Ultime attività"
                more={{ to: '/attivita', label: 'Tutto il registro' }}
              >
                {activity.isError && (
                  <p className="error m-0" role="alert">
                    {describeError(activity.error)}
                  </p>
                )}
                {activity.data && activity.data.items.length === 0 && (
                  <Empty>Nessuna attività registrata.</Empty>
                )}
                {activity.data && activity.data.items.length > 0 && (
                  <Rows>
                    {activity.data.items.map((e) => (
                      <li key={e.id} className="flex flex-col gap-0.5 py-2">
                        <span className="text-sm">{describeEvent(e)}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(e.at)} · {actorLabel(e)}
                        </span>
                      </li>
                    ))}
                  </Rows>
                )}
              </Panel>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** An indicator of the home: icon, number and what it counts, the whole card a link. */
function Kpi({
  to,
  icon,
  value,
  label,
  detail,
  tone,
}: {
  to: string;
  icon: React.ReactNode;
  value: number;
  label: string;
  detail: string;
  tone?: 'alert' | 'warn';
}) {
  return (
    <li>
      <Card
        className={cn(
          'h-full gap-2 transition-colors hover:border-primary',
          tone === 'warn' && 'border-warning/30 bg-warning-background',
          tone === 'alert' && 'border-destructive/30 bg-destructive/5',
        )}
      >
        <Link to={to} className="flex items-center gap-3 text-foreground no-underline">
          <span
            className={cn(
              'flex size-10 items-center justify-center rounded-md bg-secondary text-primary [&_svg]:size-5',
              tone === 'warn' && 'bg-card text-warning',
              tone === 'alert' && 'bg-card text-destructive',
            )}
          >
            {icon}
          </span>
          <span className="flex flex-col">
            <strong className="text-2xl leading-none">{value}</strong>{' '}
            <span className="text-sm font-medium">{label}</span>
          </span>
        </Link>
        <span className="text-sm text-muted-foreground">{detail}</span>
      </Card>
    </li>
  );
}

function Panel({
  id,
  title,
  more,
  children,
}: {
  id: string;
  title: string;
  more: { to: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-2" role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle id={id}>{title}</CardTitle>
      </CardHeader>
      {children}
      <Button asChild variant="link" size="sm" className="self-start px-0">
        <Link to={more.to}>
          {more.label}
          <ArrowRight aria-hidden />
        </Link>
      </Button>
    </Card>
  );
}

function Rows({ children }: { children: React.ReactNode }) {
  return <ul className="m-0 list-none divide-y divide-border p-0">{children}</ul>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="m-0 text-sm text-muted-foreground">{children}</p>;
}
