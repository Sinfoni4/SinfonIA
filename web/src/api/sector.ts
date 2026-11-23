/**
 * Registers of the functions of a sector (Quaderno di campagna, Abilitazioni e patentini, ...).
 * The server declares the kinds of entry and their fields; the dashboard and the Mini App build
 * their forms from that, and reach the register on paths of their own (`/sector`,
 * `/miniapp/sector`), because the function is turned on apart for each.
 */

export type SectorField = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'choice';
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  options?: ReadonlyArray<{ value: string; label: string }>;
};

export type SectorRecordKind = {
  kind: string;
  label: string;
  fields: readonly SectorField[];
  titleFields: readonly string[];
  dateField?: string;
  dueField?: string;
};

export type SectorRecord = {
  id: string;
  feature: string;
  kind: string;
  kindLabel: string;
  title: string;
  data: Record<string, unknown>;
  occurredOn: string | null;
  dueDate: string | null;
  daysLeft: number | null;
  author: { id: string; email: string } | null;
  mine: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SectorRegisterPage = {
  feature: { id: string; label: string; description: string };
  kinds: readonly SectorRecordKind[];
  canManage: boolean;
  items: SectorRecord[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type SectorChannel = 'dashboard' | 'miniapp';

export type SectorFilters = {
  kind?: string;
  search?: string;
  from?: string;
  to?: string;
  expiringWithinDays?: number;
  page?: number;
  limit?: number;
};

/** The base path of a register for the channel. */
export function sectorPath(channel: SectorChannel, feature: string, id?: string): string {
  const base = `${channel === 'miniapp' ? '/miniapp/sector' : '/sector'}/${encodeURIComponent(feature)}/records`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

export function sectorRecordsQuery(
  channel: SectorChannel,
  feature: string,
  filters: SectorFilters,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '' && value !== null) params.set(key, String(value));
  }
  const query = params.toString();
  return `${sectorPath(channel, feature)}${query ? `?${query}` : ''}`;
}

/** A stored scalar as text (the server stores only strings and numbers). */
function asText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** The values of a form (all strings) as the data the server expects: numbers, no empty fields. */
export function formToData(
  kind: SectorRecordKind,
  values: Record<string, string>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of kind.fields) {
    const raw = (values[field.key] ?? '').trim();
    if (raw === '') continue;
    data[field.key] = field.type === 'number' ? Number(raw.replace(',', '.')) : raw;
  }
  return data;
}

/** The data of an entry as form values. */
export function dataToForm(
  kind: SectorRecordKind,
  data: Record<string, unknown>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of kind.fields) {
    const value = data[field.key];
    values[field.key] = asText(value);
  }
  return values;
}

/** A value of an entry for people: choices by their label, dates as dd/mm/yyyy. */
export function fieldValueLabel(field: SectorField, value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (field.type === 'choice') {
    return field.options?.find((o) => o.value === value)?.label ?? asText(value);
  }
  if (field.type === 'date' && typeof value === 'string') {
    return value.slice(0, 10).split('-').reverse().join('/');
  }
  if (field.type === 'number' && typeof value === 'number') {
    return value.toLocaleString('it-IT');
  }
  return asText(value);
}

/** The first missing required field of a form, to say before sending. */
export function missingRequired(
  kind: SectorRecordKind,
  values: Record<string, string>,
): SectorField | undefined {
  return kind.fields.find((f) => f.required && !(values[f.key] ?? '').trim());
}
