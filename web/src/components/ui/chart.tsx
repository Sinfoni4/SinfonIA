import * as React from 'react';
import * as RechartsPrimitive from 'recharts';

import { cn } from '@/lib/utils';

/**
 * shadcn/ui chart: Recharts inside a box that gives every series its colour as a CSS variable
 * (`var(--color-<key>)`) and its Italian label, with the tooltip of the dashboard-01 block.
 */

export type ChartConfig = Record<string, { label: string; color: string }>;

const ChartContext = React.createContext<ChartConfig | null>(null);

function useChart(): ChartConfig {
  const config = React.useContext(ChartContext);
  if (!config) throw new Error('useChart must be used within a ChartContainer');
  return config;
}

export function ChartContainer({
  config,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children'];
}) {
  const colors = Object.fromEntries(
    Object.entries(config).map(([key, item]) => [`--color-${key}`, item.color]),
  );
  return (
    <ChartContext.Provider value={config}>
      <div
        data-slot="chart"
        style={{ ...colors, ...style }}
        className={cn(
          'flex aspect-video justify-center text-xs',
          '[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-border/60 [&_.recharts-surface]:outline-hidden',
          className,
        )}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

type TooltipItem = { dataKey?: unknown; value?: unknown; color?: string };

export function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
}: {
  active?: boolean;
  payload?: readonly TooltipItem[];
  label?: unknown;
  labelFormatter?: (label: unknown) => React.ReactNode;
}) {
  const config = useChart();
  if (!active || !payload?.length) return null;
  return (
    <div className="grid min-w-32 gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{labelFormatter ? labelFormatter(label) : String(label)}</div>
      {payload.map((item) => {
        const key = String(item.dataKey);
        return (
          <div key={key} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ background: `var(--color-${key})` }}
            />
            <span className="text-muted-foreground">{config[key]?.label ?? key}</span>
            <span className="ml-auto font-mono font-medium tabular-nums">
              {Number(item.value ?? 0).toLocaleString('it-IT')}
            </span>
          </div>
        );
      })}
    </div>
  );
}
