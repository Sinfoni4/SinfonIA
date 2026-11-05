import * as React from 'react';

import { cn } from '@/lib/utils';

/** shadcn/ui card. */
export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-col gap-4 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return <h3 className={cn('m-0 text-base leading-tight font-semibold', className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('m-0 text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-3', className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)} {...props} />;
}
