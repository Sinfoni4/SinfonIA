import * as React from 'react';

import { cn } from '@/lib/utils';

/** shadcn/ui label (a native label: no extra dependency). */
export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      className={cn('m-0 flex flex-col gap-1.5 text-sm leading-none font-medium', className)}
      {...props}
    />
  );
}
