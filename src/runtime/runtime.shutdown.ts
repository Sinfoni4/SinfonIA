import { defaultDocumentOcrService } from '../ai/ocr/document-ocr.service.js';
import { stopTelegramPollingForRestart } from '../interface/telegram/telegram.bot.js';
import { log } from '../shared/log.js';

import { releaseProcessLock } from './runtime.processLock.js';
import { stopBackgroundWorkers } from './runtime.workers.js';

let shuttingDown = false;

export async function gracefulShutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info({ reason }, 'Graceful shutdown started');

  try {
    await stopBackgroundWorkers();
  } catch {
    // swallow
  }

  try {
    await stopTelegramPollingForRestart();
  } catch {
    // swallow
  }

  try {
    const mod = await import('../index.js');
    await mod.shutdownHttpServer();
  } catch {
    // swallow
  }

  try {
    const mod = await import('../index.js');
    await mod.disconnectPrismaClient();
  } catch {
    // swallow
  }

  try {
    await defaultDocumentOcrService.terminate();
  } catch {
    // swallow
  }

  try {
    releaseProcessLock();
  } catch {
    // swallow
  }

  await new Promise((r) => setTimeout(r, 150));
  log.info('Graceful shutdown completed');
}
