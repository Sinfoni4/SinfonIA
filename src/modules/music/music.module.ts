import { errorLabel } from '../../shared/errors.js';

import { getMusicAdapter } from './music.datasource.js';

import type {
  DomainModule,
  DomainCommand,
  DomainExecutionContext,
  DomainContext,
} from '../domain.module.js';

function extractAfterPrefix(trimmed: string, prefixLower: string): string | null {
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(prefixLower)) return null;
  const name = trimmed.slice(prefixLower.length).trim();
  return name || null;
}

function extractRecentNames(domainContext?: DomainContext): string[] {
  const raw = domainContext?.recentPractices;
  if (!Array.isArray(raw)) return [];

  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      names.push(item);
    } else if (
      item &&
      typeof item === 'object' &&
      'name' in item &&
      typeof (item as { name: unknown }).name === 'string'
    ) {
      names.push((item as { name: string }).name);
    }
  }

  return names;
}

function escapeCsvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

type ExportPracticeFilter = {
  type: 'all' | 'today' | 'month' | 'year';
  value?: number;
};

function normalizeExportFilter(payload: unknown): ExportPracticeFilter {
  if (!payload || typeof payload !== 'object' || !('filter' in payload)) {
    return { type: 'all' };
  }
  const f = (payload as { filter?: unknown }).filter;
  if (!f || typeof f !== 'object' || f === null || !('type' in f)) {
    return { type: 'all' };
  }
  const t = f.type;
  if (t === 'today' || t === 'month') {
    return { type: t };
  }
  if (t === 'year') {
    const v = (f as { value?: unknown }).value;
    return typeof v === 'number' ? { type: 'year', value: v } : { type: 'all' };
  }
  if (t === 'all') {
    return { type: 'all' };
  }
  return { type: 'all' };
}

export const musicModule: DomainModule = {
  name: 'music',
  actions: [
    'CREATE_PRACTICE',
    'GET_PRACTICE_STATUS',
    'DELETE_PRACTICE',
    'LIST_PRACTICES',
    'EXPORT_PRACTICES',
  ],

  resolve(input: string): DomainCommand | null {
    const trimmed = input.trim();

    const createName = extractAfterPrefix(trimmed, 'crea pratica ');
    if (createName !== null) {
      return { type: 'CREATE_PRACTICE', payload: { name: createName } };
    }

    const statusName = extractAfterPrefix(trimmed, 'stato pratica ');
    if (statusName !== null) {
      return { type: 'GET_PRACTICE_STATUS', payload: { name: statusName } };
    }

    const deleteName = extractAfterPrefix(trimmed, 'elimina pratica ');
    if (deleteName !== null) {
      return { type: 'DELETE_PRACTICE', payload: { name: deleteName } };
    }

    if (trimmed.toLowerCase() === 'lista pratiche') {
      return { type: 'LIST_PRACTICES', payload: {} };
    }

    const lower = trimmed.toLowerCase();
    if (lower.startsWith('export pratiche')) {
      const parts = input.trim().split(' ');
      const send = parts.includes('invia');

      let filter: ExportPracticeFilter = {
        type: 'all',
      };

      if (parts.length >= 3) {
        const token = parts[2].toLowerCase();

        if (token === 'oggi') {
          filter = { type: 'today' };
        } else if (token === 'mese') {
          filter = { type: 'month' };
        } else if (/^\d{4}$/.test(token)) {
          filter = { type: 'year', value: Number(token) };
        }
      }

      return {
        type: 'EXPORT_PRACTICES',
        payload: { filter, send },
      };
    }

    return null;
  },

  async getContext(context: DomainExecutionContext): Promise<DomainContext> {
    if (!context.tenantId || !context.userId) {
      return {
        recentPractices: [],
        totalPractices: 0,
      };
    }

    const adapter = getMusicAdapter(context.integrationType);
    return adapter.getContext({
      tenantId: context.tenantId,
      userId: context.userId,
    });
  },

  async execute(
    command: DomainCommand,
    context?: DomainExecutionContext,
    domainContext?: DomainContext,
  ): Promise<unknown> {
    try {
      if (!context?.tenantId || !context?.userId) {
        console.error('❌ MUSIC MODULE — missing execution context');
        return { message: '⚠️ Errore interno modulo music' };
      }

      const { tenantId, userId } = context;
      const adapter = getMusicAdapter(context.integrationType);

      const payload =
        typeof command.payload === 'object' && command.payload !== null ? command.payload : null;
      const name =
        payload && 'name' in payload && typeof payload.name === 'string' ? payload.name : null;

      switch (command.type) {
        case 'CREATE_PRACTICE': {
          if (!name) return null;
          console.log('🎵 [music] action=CREATE_PRACTICE');

          const created = await adapter.createPractice({
            name,
            tenantId,
            userId,
          });

          if (!created.success) {
            return { message: '⚠️ Errore interno modulo music' };
          }

          return {
            message: `🎵 Pratica creata per ${name}`,
          };
        }

        case 'LIST_PRACTICES': {
          console.log('🎵 [music] action=LIST');

          const recent = extractRecentNames(domainContext);
          if (recent.length > 0) {
            return {
              message: `🎵 Ultime pratiche:
- ${recent.join('\n- ')}`,
            };
          }

          const practices = await adapter.listPractices({ tenantId, userId });
          if (practices.length === 0) {
            return { message: '🎵 Nessuna pratica trovata' };
          }

          const list = practices
            .map((p) => p.name)
            .filter((n) => typeof n === 'string' && n.length > 0)
            .map((n) => `- ${n}`)
            .join('\n');

          if (!list) {
            return { message: '🎵 Nessuna pratica trovata' };
          }

          return {
            message: `🎵 Pratiche:
${list}`,
          };
        }

        case 'GET_PRACTICE_STATUS': {
          if (!name) return null;
          console.log('🎵 [music] action=GET_STATUS');

          const practices = await adapter.listPractices({ tenantId, userId });
          const match = practices.find((p) => p.name === name);

          if (!match) {
            return {
              message: `⚠️ Nessuna pratica trovata per ${name}`,
            };
          }

          return {
            message: `🎵 Stato pratica ${match.name}: ${match.status}`,
          };
        }

        case 'DELETE_PRACTICE': {
          if (!name) return null;
          console.log('🎵 [music] action=DELETE');

          const deleted = await adapter.deletePractice({
            name,
            tenantId,
            userId,
          });

          if (!deleted.success) {
            return {
              message: `⚠️ Nessuna pratica da eliminare per ${name}`,
            };
          }

          return {
            message: '🗑️ Pratica eliminata',
          };
        }

        case 'EXPORT_PRACTICES': {
          console.log('🎵 [music] action=EXPORT_PRACTICES');

          const practices = await adapter.listPractices({
            tenantId,
            userId,
          });

          const filter = normalizeExportFilter(command.payload);

          const now = new Date();

          let filtered = practices;

          if (filter.type !== 'all') {
            filtered = practices.filter((p) => {
              if (!p.createdAt) return false;

              const d = new Date(p.createdAt);

              if (filter.type === 'today') {
                return (
                  d.getDate() === now.getDate() &&
                  d.getMonth() === now.getMonth() &&
                  d.getFullYear() === now.getFullYear()
                );
              }

              if (filter.type === 'month') {
                return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
              }

              if (filter.type === 'year' && filter.value !== undefined) {
                return d.getFullYear() === filter.value;
              }

              return true;
            });
          }

          if (!filtered || filtered.length === 0) {
            return {
              message: '📄 Nessuna pratica da esportare',
            };
          }

          let title = '📄 Export pratiche';

          if (filter.type === 'today') {
            title += ' (oggi)';
          } else if (filter.type === 'month') {
            title += ' (mese corrente)';
          } else if (filter.type === 'year') {
            title += ` (${filter.value})`;
          }

          let csv = 'Nome,Data Creazione\n';

          for (const p of filtered) {
            const n = p.name ?? '';
            const dateRaw = p.createdAt;
            const date =
              dateRaw !== undefined && dateRaw !== null ? new Date(dateRaw).toISOString() : '';

            csv += `${escapeCsvField(n)},${escapeCsvField(date)}\n`;
          }

          const send =
            typeof command.payload === 'object' &&
            command.payload !== null &&
            'send' in command.payload &&
            (command.payload as { send?: unknown }).send === true;

          if (send) {
            console.log('📧 EXPORT DELIVERY — simulated send to accountant');

            return {
              message: `${title} inviato al commercialista (simulazione)\n\n\`\`\`\n${csv}\`\`\``,
            };
          }

          return {
            message: `${title}:\n\n\`\`\`\n${csv}\`\`\``,
          };
        }

        default:
          return null;
      }
    } catch (error) {
      console.error('❌ MUSIC MODULE DB ERROR', errorLabel(error));
      return {
        message: '⚠️ Errore interno modulo music',
      };
    }
  },
};
