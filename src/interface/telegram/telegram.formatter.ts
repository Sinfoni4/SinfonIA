import { formatMessage } from './telegram.tone.js';

import type { ExecutorInput } from '../../ai/execution/executor.types.js';

export function formatTelegramResponse(data: {
  input: string;
  command: ExecutorInput;
  result: { success: boolean; result?: unknown; error?: { code: string; message: string } };
}): string {
  const { command, result } = data;

  if (!result.success) {
    return formatMessage('error', [
      "Non sono riuscito a completare l'operazione",
      'Puoi riprovare tra un attimo',
    ]);
  }

  if (command.action === 'create_practice') {
    const artistName =
      typeof command.data.artistName === 'string' ? command.data.artistName : 'artista';
    return formatMessage('success', [
      `Ho creato la pratica per ${artistName}`,
      'Stato attuale: CREATED',
    ]);
  }

  if (command.action === 'transition_practice') {
    const state = typeof command.data.nextState === 'string' ? command.data.nextState : 'UNKNOWN';

    if (state === 'VALIDATED') {
      return formatMessage('success', ['Ho validato la pratica', 'Ora è in stato VALIDATED']);
    }
    if (state === 'COMPLETED') {
      return formatMessage('success', ['Ho completato la pratica', 'Tutto è stato registrato']);
    }
    return formatMessage('info', [`La pratica è attualmente ${state}`]);
  }

  return formatMessage('success', ["Ho completato l'operazione"]);
}
