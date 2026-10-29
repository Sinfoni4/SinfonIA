import type { PracticeExportFilter } from './practice.export.js';
import type { PracticeState } from '../types/workflow.types.js';

export type PracticeCommand =
  | { type: 'CREATE_PRACTICE'; payload: { name: string } }
  | { type: 'GET_PRACTICE_STATUS'; payload: { name: string } }
  | { type: 'DELETE_PRACTICE'; payload: { name: string } }
  | { type: 'LIST_PRACTICES'; payload: Record<string, never> }
  | {
      type: 'EXPORT_PRACTICES';
      payload: { filter: PracticeExportFilter; send: boolean };
    }
  // Explicit requests on the whole organization (C2): the chat default view is the caller's own.
  | { type: 'LIST_ORG_PRACTICES'; payload: { page: number } }
  | { type: 'GET_ORG_PRACTICE_STATUS'; payload: { name: string } }
  | { type: 'TRANSITION_ORG_PRACTICE'; payload: { name: string; nextState: ChatTransition } }
  // Never parsed from text: sent by the chat after the person confirms a transition (C2).
  | { type: 'CONFIRM_TRANSITION'; payload: { practiceId: string; nextState: ChatTransition } };

/** States a practice can be moved to with a chat command. */
export type ChatTransition = Extract<PracticeState, 'VALIDATED' | 'COMPLETED'>;

const ORG_LIST = /^(?:lista\s+)?pratiche\s+(?:dell['’]\s*)?azienda(?:\s+(\d{1,4}))?$/i;
const ORG_TRANSITIONS = [
  ['valida pratica azienda ', 'VALIDATED'],
  ['completa pratica azienda ', 'COMPLETED'],
] as const;

function extractAfterPrefix(trimmed: string, prefixLower: string): string | null {
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(prefixLower)) return null;
  const name = trimmed.slice(prefixLower.length).trim();
  return name || null;
}

export function parsePracticeCommand(input: string): PracticeCommand | null {
  const trimmed = input.trim();

  // Organization forms first: «stato pratica azienda X» is not the practice named «azienda X».
  const orgList = ORG_LIST.exec(trimmed);
  if (orgList) {
    return { type: 'LIST_ORG_PRACTICES', payload: { page: Math.max(1, Number(orgList[1] ?? 1)) } };
  }
  const orgStatusName = extractAfterPrefix(trimmed, 'stato pratica azienda ');
  if (orgStatusName !== null) {
    return { type: 'GET_ORG_PRACTICE_STATUS', payload: { name: orgStatusName } };
  }
  for (const [prefix, nextState] of ORG_TRANSITIONS) {
    const name = extractAfterPrefix(trimmed, prefix);
    if (name !== null) return { type: 'TRANSITION_ORG_PRACTICE', payload: { name, nextState } };
  }

  const createName = extractAfterPrefix(trimmed, 'crea pratica ');
  // "crea pratica per Mario Rossi" is natural language, not an exact command:
  // let the AI flow create the canonical artist practice instead of a music one.
  if (createName !== null && !/^(per|di|del|della|dei|degli|delle|da|con)\b/i.test(createName)) {
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
    const parts = trimmed.split(/\s+/);
    const send = parts.includes('invia');

    let filter: PracticeExportFilter = { type: 'all' };

    if (parts.length >= 3) {
      const token = parts[2]?.toLowerCase();

      if (token === 'oggi') {
        filter = { type: 'today' };
      } else if (token === 'mese') {
        filter = { type: 'month' };
      } else if (token !== undefined && /^\d{4}$/.test(token)) {
        filter = { type: 'year', value: Number(token) };
      }
    }

    return {
      type: 'EXPORT_PRACTICES',
      payload: { filter, send },
    };
  }

  return null;
}
