import { Slot } from '@radix-ui/react-slot';
import { PanelLeft } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui sidebar, as in the dashboard-01 block: on a computer a column that can be hidden
 * (offcanvas), with the page beside it in an inset panel; on a phone a panel sliding in. Only the
 * parts the dashboard uses; the open/closed choice is remembered on this device.
 */

const STORAGE_KEY = 'sinfonia.sidebar';
const SHORTCUT = 'b';

type SidebarContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggle: () => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const context = React.useContext(SidebarContext);
  if (!context) throw new Error('useSidebar must be used within a SidebarProvider');
  return context;
}

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'closed';
  } catch {
    return true;
  }
}

export function SidebarProvider({
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'>) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);
  const [open, setOpenState] = React.useState(readStored);
  const setOpen = React.useCallback((value: boolean) => {
    setOpenState(value);
    try {
      localStorage.setItem(STORAGE_KEY, value ? 'open' : 'closed');
    } catch {
      // Private window or blocked storage: the choice lasts until the page is reloaded.
    }
  }, []);
  const toggle = React.useCallback(() => {
    if (isMobile) setOpenMobile((value) => !value);
    else setOpen(!open);
  }, [isMobile, open, setOpen]);

  // Ctrl+B (Cmd+B on a Mac) shows or hides the sidebar, as in shadcn/ui.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  const value = React.useMemo(
    () => ({ open, setOpen, openMobile, setOpenMobile, isMobile, toggle }),
    [open, setOpen, openMobile, isMobile, toggle],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        style={
          {
            '--sidebar-width': '16rem',
            '--header-height': '3rem',
            ...style,
          } as React.CSSProperties
        }
        className={cn(
          'group/sidebar-wrapper flex min-h-svh w-full bg-sidebar text-foreground',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function Sidebar({
  className,
  children,
  label,
  ...props
}: React.ComponentProps<'div'> & { label: string }) {
  const { isMobile, open, openMobile, setOpenMobile } = useSidebar();

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          side="left"
          closeLabel="Chiudi il menu"
          className="w-(--sidebar-width) max-w-[85vw] bg-sidebar p-0 text-sidebar-foreground"
        >
          <SheetTitle className="sr-only">{label}</SheetTitle>
          <SheetDescription className="sr-only">Le sezioni della dashboard.</SheetDescription>
          {/* A link chosen closes the panel, also when it leads to the page already open. */}
          <div
            data-sidebar="sidebar"
            className="flex h-full w-full flex-col"
            onClickCapture={(event) => {
              if ((event.target as Element).closest('a')) setOpenMobile(false);
            }}
          >
            {children}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  const state = open ? 'expanded' : 'collapsed';
  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block"
      data-state={state}
      data-collapsible={open ? '' : 'offcanvas'}
      data-variant="inset"
    >
      {/* Keeps the room of the sidebar in the page; none when hidden. */}
      <div className="relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear group-data-[collapsible=offcanvas]:w-0" />
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-10 hidden h-svh w-(--sidebar-width) p-2 transition-[left] duration-200 ease-linear md:flex',
          'group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]',
          className,
        )}
        // Hidden off screen: out of the keyboard's way and of screen readers too.
        inert={!open}
        aria-label={label}
        role="complementary"
        {...props}
      >
        <div data-sidebar="sidebar" className="flex h-full w-full flex-col bg-sidebar">
          {children}
        </div>
      </div>
    </div>
  );
}

export function SidebarTrigger({ className, ...props }: React.ComponentProps<typeof Button>) {
  const { toggle, isMobile, open, openMobile } = useSidebar();
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('size-8 text-foreground', className)}
      onClick={toggle}
      aria-expanded={isMobile ? openMobile : open}
      {...props}
    >
      <PanelLeft aria-hidden />
      <span className="sr-only">
        {isMobile ? 'Menu' : open ? 'Nascondi la barra laterale' : 'Mostra la barra laterale'}
      </span>
    </Button>
  );
}

/** The page beside the sidebar: a raised panel, as the inset variant of dashboard-01. */
export function SidebarInset({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-inset"
      className={cn(
        'relative flex w-full min-w-0 flex-1 flex-col bg-background',
        'md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm',
        'md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2',
        className,
      )}
      {...props}
    />
  );
}

export function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-2 p-2', className)} {...props} />;
}

export function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-2 p-2', className)} {...props} />;
}

export function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-2 overflow-auto', className)} {...props} />
  );
}

export function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('relative flex w-full min-w-0 flex-col p-2', className)} {...props} />;
}

export function SidebarGroupLabel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70',
        className,
      )}
      {...props}
    />
  );
}

export function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      className={cn('m-0 flex w-full min-w-0 list-none flex-col gap-1 p-0', className)}
      {...props}
    />
  );
}

export function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return <li className={cn('relative', className)} {...props} />;
}

export function SidebarMenuButton({
  asChild = false,
  isActive = false,
  size = 'default',
  className,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean;
  isActive?: boolean;
  size?: 'default' | 'lg';
}) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      data-active={isActive}
      className={cn(
        'm-0 flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md border-0 bg-transparent p-2 text-left text-sm text-sidebar-foreground no-underline transition-colors',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring',
        'data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground',
        'disabled:pointer-events-none disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
        size === 'lg' ? 'h-12' : 'h-8',
        className,
      )}
      {...props}
    />
  );
}
