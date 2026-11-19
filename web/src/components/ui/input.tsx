import * as React from 'react';

import { cn } from '@/lib/utils';

/** shadcn/ui input. */
export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-sm text-foreground shadow-xs placeholder:text-muted-foreground focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-55',
        className,
      )}
      {...props}
    />
  );
}
