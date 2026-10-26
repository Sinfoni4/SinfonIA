import { setPending } from '../telegram/telegram.conversation.js';
import { getUserRole } from '../telegram/telegram.roles.js';
import { formatMessage } from '../telegram/telegram.tone.js';

export function handleStatus(): Promise<string> {
  return Promise.resolve(
    formatMessage('info', ['Ho controllato la pratica', 'È attualmente VALIDATED']),
  );
}

export function handleList(): Promise<string> {
  return Promise.resolve(
    ['📂 Ecco le tue pratiche:', '• Mario Rossi — VALIDATED', '• Luca Bianchi — CREATED'].join(
      '\n',
    ),
  );
}

export function handleNextStep(userId: string): Promise<string> {
  const role = getUserRole(userId);

  if (role === 'OPERATORE') {
    return Promise.resolve(
      ['👉 Puoi fare questo:', '• validare pratiche', '• completarle'].join('\n'),
    );
  }

  return Promise.resolve(
    ['👉 Puoi fare questo:', '• creare una pratica', '• controllare lo stato'].join('\n'),
  );
}

export function handleAmbiguity(userId: string): Promise<string> {
  setPending(userId, {
    type: 'AMBIGUITY_SELECTION',
    options: ['10 marzo', '12 marzo'],
  });

  return Promise.resolve(
    `⚠️ Ho trovato più pratiche:\n• Mario Rossi (10 marzo)\n• Mario Rossi (12 marzo)\nQuale intendi?`,
  );
}
