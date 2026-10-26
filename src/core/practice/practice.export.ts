export type PracticeExportFilter =
  { type: 'all' } | { type: 'today' } | { type: 'month' } | { type: 'year'; value: number };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function normalizeExportFilter(payload: unknown): PracticeExportFilter {
  const record = asRecord(payload);
  if (!record) return { type: 'all' };

  const rawFilter = 'filter' in record ? record.filter : record;
  const filter = asRecord(rawFilter);
  if (!filter || typeof filter.type !== 'string') return { type: 'all' };

  if (filter.type === 'today' || filter.type === 'month' || filter.type === 'all') {
    return { type: filter.type };
  }

  if (filter.type === 'year') {
    const value = filter.value;
    if (typeof value === 'number' && Number.isInteger(value)) {
      return { type: 'year', value };
    }
  }

  return { type: 'all' };
}

export function isWithinExportFilter(
  createdAt: Date,
  filter: PracticeExportFilter,
  now: Date = new Date(),
): boolean {
  if (filter.type === 'all') return true;

  if (filter.type === 'today') {
    return (
      createdAt.getFullYear() === now.getFullYear() &&
      createdAt.getMonth() === now.getMonth() &&
      createdAt.getDate() === now.getDate()
    );
  }

  if (filter.type === 'month') {
    return createdAt.getFullYear() === now.getFullYear() && createdAt.getMonth() === now.getMonth();
  }

  return createdAt.getFullYear() === filter.value;
}

export function exportFilterTitle(filter: PracticeExportFilter): string {
  switch (filter.type) {
    case 'today':
      return '📄 Export pratiche (oggi)';
    case 'month':
      return '📄 Export pratiche (mese corrente)';
    case 'year':
      return `📄 Export pratiche (${filter.value})`;
    default:
      return '📄 Export pratiche';
  }
}

export function escapeCsvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
