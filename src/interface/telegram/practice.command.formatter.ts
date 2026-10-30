import type { PracticeCommandResult } from '../../core/practice/practice.application.service.js';
import type { ChatTransition } from '../../core/practice/practice.commands.js';

const TRANSITION_LABELS: Record<ChatTransition, string> = {
  VALIDATED: 'validare',
  COMPLETED: 'completare',
};

function shortDate(date: Date): string {
  return date.toISOString().slice(0, 10).split('-').reverse().join('/');
}

export function formatPracticeCommandResult(result: PracticeCommandResult): string {
  switch (result.type) {
    case 'created':
      return `🎵 Pratica creata: ${result.practice.name}`;

    case 'list': {
      if (result.practices.length === 0) {
        return '🎵 Nessuna pratica trovata';
      }

      const list = result.practices.map((practice) => `- ${practice.name}`).join('\n');
      return `🎵 Pratiche:\n${list}`;
    }

    case 'status':
      return `🎵 Stato pratica ${result.practice.name}: ${result.practice.status}`;

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
        `Vuoi davvero ${TRANSITION_LABELS[result.nextState]}la? ` +
        'Rispondi «sì» per confermare, qualsiasi altra risposta annulla.'
      );

    case 'transitioned':
      return `✅ Pratica ${result.practice.name}: ${result.practice.status}`;
  }
}
