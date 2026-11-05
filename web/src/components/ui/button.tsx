import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/** shadcn/ui button, with the SinfonIA colours. `asChild` styles a link as a button. */
export const buttonVariants = cva(
  'm-0 inline-flex min-h-0 cursor-pointer shadow-none items-center justify-center gap-2 rounded-md border text-sm font-medium whitespace-nowrap no-underline transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-55 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-primary bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        outline: 'border-border bg-card text-primary shadow-xs hover:bg-accent',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'border-transparent bg-transparent text-primary hover:bg-accent',
        destructive: 'border-destructive bg-destructive text-white hover:bg-destructive/90',
        link: 'h-auto border-transparent bg-transparent p-0 text-primary underline-offset-4 hover:bg-transparent hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3',
        lg: 'h-10 px-6',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
