import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Columns3,
} from 'lucide-react';
import { useState } from 'react';

import type * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/** The column's name in «Colonne» and, when the header is not plain text, for screen readers. */
type Meta = { label: string; className?: string };

export type DataColumn<T> = ColumnDef<T> & { meta: Meta };

/**
 * The data table of the dashboard-01 block (TanStack Table + shadcn/ui): the filters on the left,
 * the choice of the columns on the right, the table in its frame, the pages below. The data are
 * one page already filtered by the backend: sorting and paging happen there, not here.
 */
export function DataTable<T>({
  label,
  columns,
  data,
  rowKey,
  toolbar,
  empty,
  pagination,
  hiddenColumns = {},
}: {
  /** The name of the table for screen readers (e.g. «Elenco delle pratiche»). */
  label: string;
  columns: Array<DataColumn<T>>;
  data: T[];
  rowKey: (row: T) => string;
  toolbar?: React.ReactNode;
  empty: string;
  pagination?: React.ComponentProps<typeof TablePagination>;
  /** Columns hidden at first (the person can show them with «Colonne»). */
  hiddenColumns?: VisibilityState;
}) {
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(hiddenColumns);
  const table = useReactTable({
    data,
    columns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getRowId: rowKey,
    manualPagination: true,
  });
  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide());

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-end gap-3">{toolbar}</div>
        {hideable.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="text-foreground">
                <Columns3 aria-hidden />
                Colonne
                <ChevronDown aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {hideable.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  checked={column.getIsVisible()}
                  onCheckedChange={(value) => column.toggleVisibility(value)}
                  // The menu stays open to show or hide more than one column.
                  onSelect={(event) => event.preventDefault()}
                >
                  {(column.columnDef.meta as Meta).label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <TableFrame>
        <Table aria-label={label}>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    scope="col"
                    className={(header.column.columnDef.meta as Meta).className}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={table.getVisibleLeafColumns().length}
                  className="h-24 text-center text-muted-foreground"
                >
                  {empty}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={(cell.column.columnDef.meta as Meta).className}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableFrame>

      {pagination && <TablePagination {...pagination} />}
    </div>
  );
}

const PAGE_SIZES = [10, 20, 50];

/**
 * The pages under a table, as in dashboard-01: how many in all, rows per page, «Pagina x di y»
 * and the buttons to the first, previous, next and last page.
 */
export function TablePagination({
  page,
  totalPages,
  total,
  noun,
  limit,
  onPage,
  onLimit,
}: {
  page: number;
  totalPages: number;
  total: number;
  /** Singular and plural of what is counted: ['pratica', 'pratiche']. */
  noun: [string, string];
  limit?: number;
  onPage: (page: number) => void;
  onLimit?: (limit: number) => void;
}) {
  const last = Math.max(1, totalPages);
  return (
    <nav
      aria-label="Pagine"
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 text-sm"
    >
      <span className="text-muted-foreground">
        {total} {total === 1 ? noun[0] : noun[1]}
      </span>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {limit !== undefined && onLimit && (
          <label className="m-0 hidden items-center gap-2 font-medium lg:flex">
            Righe per pagina
            <NativeSelect
              className="h-8 w-20"
              value={limit}
              onChange={(e) => onLimit(Number(e.target.value))}
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
        <span className="font-medium">
          Pagina {page} di {last}
        </span>
        <div className="flex items-center gap-2">
          <PageButton
            label="Prima pagina"
            className="hidden lg:inline-flex"
            disabled={page <= 1}
            onClick={() => onPage(1)}
          >
            <ChevronsLeft aria-hidden />
          </PageButton>
          <PageButton label="Precedente" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            <ChevronLeft aria-hidden />
          </PageButton>
          <PageButton label="Successiva" disabled={page >= last} onClick={() => onPage(page + 1)}>
            <ChevronRight aria-hidden />
          </PageButton>
          <PageButton
            label="Ultima pagina"
            className="hidden lg:inline-flex"
            disabled={page >= last}
            onClick={() => onPage(last)}
          >
            <ChevronsRight aria-hidden />
          </PageButton>
        </div>
      </div>
    </nav>
  );
}

function PageButton({
  label,
  children,
  className,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn('size-8 text-foreground', className)}
      {...props}
    >
      <span className="sr-only">{label}</span>
      {children}
    </Button>
  );
}
