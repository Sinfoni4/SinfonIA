import type { PracticeCommandResult } from '../../core/practice/practice.application.service.js';

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
      return `⚠️ Nessuna pratica trovata per ${result.name}`;
  }
}
