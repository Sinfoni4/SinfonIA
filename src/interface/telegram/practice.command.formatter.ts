import type { ChecklistState } from '../../core/practice/document-checklist.js';
import type {
  ChatFileState,
  PracticeCommandResult,
  PracticeDocuments,
} from '../../core/practice/practice.application.service.js';
import type { PracticeState } from '../../core/types/workflow.types.js';

/** The verb of a transition, as in «vuoi davvero validarla?». */
export const TRANSITION_VERBS: Record<PracticeState, string> = {
  CREATED: 'riportare a «creata»',
  VALIDATED: 'validare',
  SUBMITTED: 'segnare come inviata',
  FAILED: 'segnare come non riuscita',
  COMPLETED: 'completare',
};

/** States that cannot be changed any more. */
export const FINAL_STATES: ReadonlySet<PracticeState> = new Set(['COMPLETED', 'FAILED']);

function shortDate(date: Date): string {
  return date.toISOString().slice(0, 10).split('-').reverse().join('/');
}

const EXPECTED_STATE: Record<ChecklistState, string> = {
  valid: '✅ {label} — confermato',
  to_verify: '🕓 {label} — ricevuto, da controllare',
  rejected: '❌ {label} — rifiutato, va rimandato',
  missing: '⬜ {label} — manca',
};

const FILE_STATE: Record<ChatFileState, string> = {
  confirmed: '✅ confermato',
  read: '📄 letto',
  to_check: '🕓 da controllare',
  reading: '⏳ in lettura',
  unreadable: '⚠️ non leggibile',
  rejected: '❌ rifiutato',
};

function isoToItalian(date: string): string {
  return date.split('-').reverse().join('/');
}

/** AGX-12b: one practice's documents, as lines for the chat. */
export function formatPracticeDocuments(p: PracticeDocuments): string {
  const lines = [`📁 ${p.name}`];
  const asked = new Map(
    p.requests.filter((r) => r.label).map((r) => [r.label as string, r.dueDate]),
  );
  for (const item of p.expected) {
    let line = EXPECTED_STATE[item.state].replace('{label}', item.label);
    if (item.state === 'missing' && !item.required) line += ' (facoltativo)';
    const due = asked.get(item.label);
    if (item.state !== 'valid' && asked.has(item.label)) {
      line += due ? ` · richiesto entro il ${isoToItalian(due)}` : ' · richiesto';
    }
    lines.push(line);
  }
  for (const r of p.requests.filter(
    (x) => !x.label || !p.expected.some((e) => e.label === x.label),
  )) {
    const due = r.dueDate ? ` (entro il ${isoToItalian(r.dueDate)})` : '';
    lines.push(`📨 Richiesto: ${r.label ?? r.message}${due}`);
  }
  for (const f of p.files) lines.push(`📎 ${f.fileName} — ${FILE_STATE[f.state]}`);
  if (p.otherFiles > 0) lines.push(`… e altri ${p.otherFiles} file`);
  if (lines.length === 1) lines.push('Nessun documento previsto né ricevuto.');
  return lines.join('\n');
}

export function formatPracticeCommandResult(result: PracticeCommandResult): string {
  switch (result.type) {
    case 'created':
      return `📋 Pratica creata: ${result.practice.name}`;

    case 'list': {
      if (result.practices.length === 0) {
        return '📋 Nessuna pratica trovata';
      }

      const list = result.practices.map((practice) => `- ${practice.name}`).join('\n');
      return `📋 Pratiche:\n${list}`;
    }

    case 'documents': {
      if (result.practices.length === 0) {
        return '📁 Non hai pratiche aperte con documenti.';
      }
      const more =
        result.more > 0
          ? `\n\nAltre ${result.more} pratiche: scrivi «documenti» seguito dal nome della pratica.`
          : '';
      const tail =
        '\n\nPer mandare un documento allegalo qui con il nome della pratica nella didascalia.';
      return result.practices.map(formatPracticeDocuments).join('\n\n') + more + tail;
    }

    case 'status':
      return `📋 Stato pratica ${result.practice.name}: ${result.practice.status}`;

    case 'confirm_delete':
      return (
        `🗑️ Vuoi davvero eliminare la pratica ${result.practice.name}? ` +
        "L'eliminazione non si può annullare. Rispondi «sì» per confermare, qualsiasi altra " +
        'risposta annulla.'
      );

    case 'delete_denied':
      return (
        `🔒 La pratica ${result.practice.name} è stata aperta per te: può eliminarla solo chi ` +
        "l'ha aperta. Se serve, scrivi «operatore»."
      );

    case 'deleted':
      return `🗑️ Pratica eliminata: ${result.practice.name}`;

    case 'export': {
      if (result.result.count === 0) {
        return '📄 Nessuna pratica da esportare';
      }

      if (result.send) {
        return `${result.result.title} inviato al commercialista (simulazione)\n\n\`\`\`\n${result.result.csv}\`\`\``;
      }

      return `${result.result.title}:\n\n\`\`\`\n${result.result.csv}\`\`\``;
    }

    case 'not_found':
      return result.orgHint
        ? `⚠️ Nessuna delle tue pratiche si chiama ${result.name}.\n` +
            `Per cercarla tra le pratiche dell'azienda scrivi «stato pratica azienda ${result.name}».`
        : `⚠️ Nessuna pratica trovata per ${result.name}`;

    case 'org_list': {
      if (result.total === 0) return "🏢 Nessuna pratica nell'azienda";
      const list = result.practices
        .map((p) => `- ${p.name}: ${p.status}${p.own ? ' (tua)' : ''}`)
        .join('\n');
      const more =
        result.page < result.totalPages
          ? `\n\nAltre pratiche: scrivi «pratiche azienda ${result.page + 1}».`
          : '';
      return (
        `🏢 Pratiche dell'azienda (pagina ${result.page} di ${result.totalPages}, ` +
        `${result.total} in tutto):\n${list}${more}`
      );
    }

    case 'org_status':
      return (
        `🏢 Stato pratica ${result.practice.name}: ${result.practice.status}` +
        (result.own ? ' (tua)' : '')
      );

    case 'ambiguous': {
      const list = result.practices
        .map((p) => `- ${p.name}: ${p.status}, creata il ${shortDate(p.createdAt)}`)
        .join('\n');
      return (
        `⚠️ Nell'azienda ci sono ${result.practices.length} pratiche chiamate ${result.name}:\n` +
        `${list}\n\nNon ho fatto nulla: usa la dashboard per scegliere quella giusta.`
      );
    }

    case 'org_view_denied':
      return '🔒 Con il tuo ruolo puoi vedere solo le tue pratiche: scrivi «lista pratiche».';

    case 'confirm_transition':
      return (
        `⚠️ La pratica ${result.practice.name} (${result.practice.status}) non è tua.\n` +
        `Vuoi davvero ${TRANSITION_VERBS[result.nextState]} questa pratica? ` +
        'Rispondi «sì» per confermare, qualsiasi altra risposta annulla.'
      );

    case 'transitioned':
      return `✅ Pratica ${result.practice.name}: ${result.practice.status}`;
  }
}
