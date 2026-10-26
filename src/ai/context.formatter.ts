import { errorLabel } from '../shared/errors.js';

export function formatDomainContext(moduleName: string, context?: Record<string, unknown>): string {
  if (!context) {
    return 'Contesto: non disponibile';
  }

  try {
    switch (moduleName) {
      case 'music':
        return formatMusicContext(context);

      default:
        return formatGenericContext(context);
    }
  } catch (err) {
    console.error('❌ CONTEXT FORMATTER ERROR', errorLabel(err));
    return 'Contesto: non disponibile';
  }
}

function formatMusicContext(context: Record<string, unknown>): string {
  const total = context.totalPractices as number | undefined;
  const recentRaw = context.recentPractices;

  let output = 'Contesto utente:\n';

  if (typeof total === 'number') {
    output += `- Numero pratiche: ${total}\n`;
  }

  const names: string[] = [];
  if (Array.isArray(recentRaw) && recentRaw.length > 0) {
    for (const item of recentRaw.slice(0, 5)) {
      if (typeof item === 'string' && item.trim()) {
        names.push(item);
      } else if (
        item &&
        typeof item === 'object' &&
        item !== null &&
        'name' in item &&
        typeof (item as { name: unknown }).name === 'string'
      ) {
        names.push((item as { name: string }).name);
      }
    }
  }

  if (names.length > 0) {
    output += '- Ultime pratiche:\n';
    for (const name of names) {
      output += `  - ${name}\n`;
    }
  } else {
    output += '- Nessuna pratica recente\n';
  }

  return output.trim();
}

function formatGenericContext(context: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(context, null, 2);

    if (json.length > 500) {
      return 'Contesto (ridotto): ' + json.slice(0, 500) + '...';
    }

    return 'Contesto:\n' + json;
  } catch {
    return 'Contesto: non disponibile';
  }
}
