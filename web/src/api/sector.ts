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
  /** number: the most decimal places accepted. */
  decimals?: number;
  options?: ReadonlyArray<{ value: string; label: string }>;
};

export type SectorRecordKind = {
  kind: string;
  label: string;
  fields: readonly SectorField[];
  titleFields: readonly string[];
  dateField?: string;
  dueField?: string;
  /** Label of the optional person of the organization to remind of the expiry. */
  notify?: string;
};

/** A person of the organization: email, or a chat-only account. */
export type SectorPerson = { id: string; label: string };

/** The form value holding the person to remind (beside the declared fields). */
export const NOTIFY_KEY = 'notify';

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
  notify: SectorPerson | null;
  mine: boolean;
  attachments: SectorAttachment[];
  /** The current version: 1 when written, +1 at every correction or voiding (older APIs: none). */
  version?: number;
  /** When, why and by whom it was voided; null for an entry in force (older APIs: none). */
  voided?: { at: string; reason: string; by: string | null } | null;
  createdAt: string;
  updatedAt: string;
};

/** One version of an entry, as kept in its history. */
export type SectorRecordVersion = {
  version: number;
  action: 'CREATED' | 'CORRECTED' | 'VOIDED';
  title: string;
  data: Record<string, unknown>;
  occurredOn: string | null;
  dueDate: string | null;
  reason: string | null;
  channel: string | null;
  author: string | null;
  changedAt: string;
};

export const VERSION_ACTIONS: Record<SectorRecordVersion['action'], string> = {
  CREATED: 'Inserita',
  CORRECTED: 'Rettificata',
  VOIDED: 'Annullata',
};

/** The shortest reason the server accepts for a correction or a voiding. */
export const REASON_MIN = 3;

/** What is wrong with a reason before sending it, or null. */
export function reasonProblem(reason: string, what: 'rettifica' | 'annullamento'): string | null {
  return reason.trim().length >= REASON_MIN
    ? null
    : `Scrivi il motivo ${what === 'rettifica' ? 'della rettifica' : 'dell’annullamento'} (almeno ${REASON_MIN} caratteri).`;
}

/** The fields a version changed from the one before, as people read them. */
export function versionChanges(
  kind: SectorRecordKind | undefined,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Array<{ label: string; before: string; after: string }> {
  if (!kind) return [];
  return kind.fields
    .map((f) => ({
      label: f.label,
      before: fieldValueLabel(f, before[f.key]),
      after: fieldValueLabel(f, after[f.key]),
    }))
    .filter((c) => c.before !== c.after);
}

export type SectorAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
};

export type SectorRegisterPage = {
  feature: { id: string; label: string; description: string };
  kinds: readonly SectorRecordKind[];
  canManage: boolean;
  /** Whether entries may be voided (through a delegation: with its DELETE); older APIs: none. */
  canVoid?: boolean;
  /** Who may be named as the person to remind (all people for staff, oneself for a member). */
  people: SectorPerson[];
  /** Through a delegation: whose register it is and what the delegation allows. */
  delegation?: { grantorName: string; operations: string[]; validUntil: string };
  items: SectorRecord[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

/** Where a register is reached: the dashboard, the Mini App, or a delegation received (MF8). */
export type SectorChannel = 'dashboard' | 'miniapp' | { grantId: string };

/** Entries in force, voided ones, or both. */
export type SectorRecordState = 'active' | 'voided' | 'all';

export type SectorFilters = {
  kind?: string;
  state?: SectorRecordState | '';
  search?: string;
  from?: string;
  to?: string;
  expiringWithinDays?: number;
  page?: number;
  limit?: number;
};

/** The base path of a register for the channel. */
export function sectorPath(channel: SectorChannel, feature: string, id?: string): string {
  const root =
    typeof channel === 'object'
      ? `/grants/${encodeURIComponent(channel.grantId)}/sector`
      : channel === 'miniapp'
        ? '/miniapp/sector'
        : '/sector';
  const base = `${root}/${encodeURIComponent(feature)}/records`;
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

/** Where an entry is voided (POST, with the reason). */
export function sectorVoidPath(channel: SectorChannel, feature: string, id: string): string {
  return `${sectorPath(channel, feature, id)}/void`;
}

/** The history of an entry. */
export function sectorVersionsPath(channel: SectorChannel, feature: string, id: string): string {
  return `${sectorPath(channel, feature, id)}/versions`;
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
  // No person sent clears it on the server.
  if (kind.notify && values[NOTIFY_KEY]) data[NOTIFY_KEY] = values[NOTIFY_KEY];
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
  if (kind.notify) values[NOTIFY_KEY] = asText(data[NOTIFY_KEY]);
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

export type SectorExportFormat = 'csv' | 'xlsx' | 'pdf';

/** The register as a file, with the filters of the page (not its page and size). */
export function sectorExportPath(
  channel: SectorChannel,
  feature: string,
  format: SectorExportFormat,
  filters: SectorFilters,
): string {
  const query = sectorRecordsQuery(channel, feature, {
    ...filters,
    page: undefined,
    limit: undefined,
  }).split('?')[1];
  return `${sectorPath(channel, feature)}/export?format=${format}${query ? `&${query}` : ''}`;
}

/** The address of a file of an entry. */
export function sectorFilePath(
  channel: SectorChannel,
  feature: string,
  recordId: string,
  attachmentId?: string,
): string {
  const base = `${sectorPath(channel, feature, recordId)}/attachments`;
  return attachmentId ? `${base}/${encodeURIComponent(attachmentId)}` : base;
}

/** Saves a downloaded file on the device, never opening it in the page. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/** A file size for people: «820 kB», «2,4 MB». */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  return `${(bytes / 1024 / 1024).toLocaleString('it-IT', { maximumFractionDigits: 1 })} MB`;
}
