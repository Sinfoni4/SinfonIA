import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CalendarClock,
  FileSearch,
  FolderOpen,
  FolderPlus,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
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
import { ActivityChart } from '../components/ActivityChart';
import { useSession } from '../session/session';

import type * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * P11: the numbers of the organization (G7), in the layout of the dashboard-01 block: four
 * indicators, the chart of the last months, then deadlines, documents to check, latest practices
 * and, for administrators, the latest activity. A MEMBER sees only their own.
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
  const trend = s?.activity ? practiceTrend(s.activity) : null;

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div>
        <h1 className="m-0 text-2xl font-semibold tracking-tight">{current?.name}</h1>
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
          <ul
            className="m-0 grid list-none grid-cols-1 gap-4 p-0 @xl/main:grid-cols-2 @5xl/main:grid-cols-4"
            aria-label="Indicatori"
          >
            <Kpi
              to="/pratiche"
              icon={<FolderOpen aria-hidden />}
              value={openPractices(s)}
              label="pratiche in corso"
              badge={`${s.practices.total} in tutto`}
              note="Create, validate o inviate"
              detail={`${s.practices.byStatus.COMPLETED} completate · ${s.practices.byStatus.FAILED} non riuscite`}
            />
            <Kpi
              to="/scadenze"
              icon={<CalendarClock aria-hidden />}
              value={s.deadlines.overdue}
              label={s.deadlines.overdue === 1 ? 'scadenza scaduta' : 'scadenze scadute'}
              badge={`${s.deadlines.dueSoon} in arrivo`}
              note={s.deadlines.overdue > 0 ? 'Da sistemare subito' : 'Nessun ritardo'}
              detail={`${s.deadlines.dueSoon} nei prossimi 30 giorni`}
              tone={s.deadlines.overdue > 0 ? 'alert' : undefined}
            />
            <Kpi
              to="/verifica"
              icon={<FileSearch aria-hidden />}
              value={toCheck}
              label="documenti da controllare"
              badge={`${s.documents.unreadable} non letti`}
              note={toCheck > 0 ? 'Aspettano una conferma' : 'Tutto confermato'}
              detail={`${s.documents.toReview} da verificare · ${s.documents.unreadable} non letti`}
              tone={toCheck > 0 ? 'warn' : undefined}
            />
            {trend && (
              <Kpi
                to="/pratiche"
                icon={<FolderPlus aria-hidden />}
                value={trend.last}
                label={
                  trend.last === 1 ? 'pratica aperta in 30 giorni' : 'pratiche aperte in 30 giorni'
                }
                badge={trend.change}
                trend={trend.direction}
                note={
                  trend.direction === 'down'
                    ? 'Meno dei 30 giorni prima'
                    : trend.direction === 'up'
                      ? 'Più dei 30 giorni prima'
                      : 'Come i 30 giorni prima'
                }
                detail={`${trend.previous} nei 30 giorni precedenti`}
              />
            )}
          </ul>

          {s.activity && <ActivityChart activity={s.activity} />}

          <div className="grid items-start gap-4 md:grid-cols-2 @6xl/main:grid-cols-4">
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
                        {d.certainty === 'TO_VERIFY' && ' · da verificare'}
                        {d.certainty === 'INFORMATIONAL' && ' · informativa'}
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

/** Practices opened in the last 30 days against the 30 before (the trend badge of dashboard-01). */
function practiceTrend(activity: NonNullable<Summary['activity']>) {
  const sum = (days: typeof activity) => days.reduce((n, d) => n + d.practices, 0);
  const last = sum(activity.slice(-30));
  const previous = sum(activity.slice(-60, -30));
  const direction: 'up' | 'down' | 'flat' =
    last > previous ? 'up' : last < previous ? 'down' : 'flat';
  const percent = previous === 0 ? 0 : Math.round((Math.abs(last - previous) / previous) * 100);
  const change =
    previous === 0
      ? last === 0
        ? 'stabile'
        : 'in crescita'
      : direction === 'flat'
        ? 'stabile'
        : `${direction === 'up' ? '+' : '−'}${percent}%`;
  return { last, previous, direction, change };
}

/**
 * An indicator of the home, as the section cards of dashboard-01: what it counts, the number, a
 * badge on the right and two lines below; the whole card is a link.
 */
function Kpi({
  to,
  icon,
  value,
  label,
  badge,
  note,
  detail,
  tone,
  trend,
}: {
  to: string;
  icon: React.ReactNode;
  value: number;
  label: string;
  badge: string;
  note: string;
  detail: string;
  tone?: 'alert' | 'warn';
  trend?: 'up' | 'down' | 'flat';
}) {
  const TrendIcon = trend === 'down' ? TrendingDown : TrendingUp;
  return (
    <li className="flex">
      <Card
        className={cn(
          '@container/card relative w-full gap-3 bg-linear-to-t from-primary/5 to-card transition-colors hover:border-primary/40',
          tone === 'warn' && 'from-warning-background',
          tone === 'alert' && 'from-destructive/10',
        )}
      >
        <CardHeader>
          <CardDescription className="first-letter:uppercase">{label}</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            <Link
              to={to}
              aria-label={`${value} ${label}`}
              className="text-foreground no-underline after:absolute after:inset-0 after:rounded-xl"
            >
              {value}
            </Link>
          </CardTitle>
          <CardAction>
            <Badge
              variant={tone ? 'warning' : 'outline'}
              className={cn(tone === 'alert' && 'bg-destructive/10 text-destructive')}
            >
              {trend && trend !== 'flat' && <TrendIcon aria-hidden />}
              {badge}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1 text-sm">
          <span
            className={cn(
              'flex items-center gap-2 font-medium [&_svg]:size-4',
              tone === 'alert' && 'text-destructive',
            )}
          >
            {note}
            {icon}
          </span>
          <span className="text-muted-foreground">{detail}</span>
        </CardFooter>
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
