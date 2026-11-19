import { useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts';

import type { Summary } from '../api/organization';

import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { useIsMobile } from '@/hooks/use-mobile';

type Day = NonNullable<Summary['activity']>[number];

const RANGES = [
  { days: 90, label: 'Ultimi 3 mesi' },
  { days: 30, label: 'Ultimi 30 giorni' },
  { days: 7, label: 'Ultimi 7 giorni' },
] as const;

const config = {
  practices: { label: 'Pratiche aperte', color: 'var(--accent)' },
  documents: { label: 'Documenti ricevuti', color: '#a3a3a3' },
} satisfies ChartConfig;

/** 2026-11-19 → «19 nov» (the date is a calendar day: no time zone shift). */
function shortDate(iso: unknown): string {
  return new Date(`${String(iso)}T00:00:00Z`).toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function total(days: Day[], key: 'practices' | 'documents'): number {
  return days.reduce((sum, d) => sum + d[key], 0);
}

/**
 * The chart of the home, as the interactive area chart of dashboard-01: practices opened and
 * documents received per day, over 3 months, 30 or 7 days (7 on a phone, at first).
 */
export function ActivityChart({ activity }: { activity: Day[] }) {
  const isMobile = useIsMobile();
  const [range, setRange] = useState<number>(90);
  useEffect(() => {
    if (isMobile) setRange(7);
  }, [isMobile]);

  const shown = activity.slice(-range);
  const label = RANGES.find((r) => r.days === range)!.label.toLowerCase();

  return (
    <Card className="@container/card gap-4">
      <CardHeader>
        <CardTitle id="home-chart">Andamento</CardTitle>
        <CardDescription>
          <span className="hidden @[540px]/card:inline">
            Pratiche aperte e documenti ricevuti, {label}
          </span>
          <span className="@[540px]/card:hidden">
            {RANGES.find((r) => r.days === range)!.label}
          </span>
        </CardDescription>
        <CardAction>
          <div
            role="group"
            aria-label="Periodo del grafico"
            className="flex rounded-md border border-border"
          >
            {RANGES.map((r) => (
              <Button
                key={r.days}
                variant="ghost"
                size="sm"
                aria-pressed={range === r.days}
                className="rounded-none border-0 text-foreground first:rounded-l-md last:rounded-r-md aria-pressed:bg-accent"
                onClick={() => setRange(r.days)}
              >
                <span className="hidden @[540px]/card:inline">{r.label}</span>
                <span className="@[540px]/card:hidden">{r.days} gg</span>
              </Button>
            ))}
          </div>
        </CardAction>
      </CardHeader>
      <div
        role="img"
        aria-labelledby="home-chart"
        aria-describedby="home-chart-summary"
        className="w-full"
      >
        <p id="home-chart-summary" className="sr-only">
          {label}: {total(shown, 'practices')} pratiche aperte e {total(shown, 'documents')}{' '}
          documenti ricevuti.
        </p>
        <ChartContainer config={config} className="aspect-auto h-60 w-full">
          <AreaChart data={shown} accessibilityLayer={false} margin={{ left: 0, right: 0 }}>
            <defs>
              <linearGradient id="fillPractices" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-practices)" stopOpacity={0.8} />
                <stop offset="95%" stopColor="var(--color-practices)" stopOpacity={0.1} />
              </linearGradient>
              <linearGradient id="fillDocuments" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-documents)" stopOpacity={0.8} />
                <stop offset="95%" stopColor="var(--color-documents)" stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={shortDate}
            />
            <ChartTooltip
              cursor={false}
              content={({ active, payload, label: day }) => (
                <ChartTooltipContent
                  active={active}
                  payload={payload}
                  label={day}
                  labelFormatter={shortDate}
                />
              )}
            />
            <Area
              dataKey="documents"
              type="monotone"
              fill="url(#fillDocuments)"
              stroke="var(--color-documents)"
              stackId="a"
            />
            <Area
              dataKey="practices"
              type="monotone"
              fill="url(#fillPractices)"
              stroke="var(--color-practices)"
              stackId="a"
            />
          </AreaChart>
        </ChartContainer>
      </div>
    </Card>
  );
}
