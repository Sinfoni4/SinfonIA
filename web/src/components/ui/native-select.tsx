import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * A native select with the look of the shadcn/ui fields: keyboard, screen readers and phones
 * get the system menu.
 */
export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-sm text-foreground shadow-xs focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-55',
        className,
      )}
      {...props}
    />
  );
}
