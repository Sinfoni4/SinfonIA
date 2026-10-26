import { stopTelegramPollingForRestart } from '../interface/telegram/telegram.bot.js';

import { releaseProcessLock } from './runtime.processLock.js';

let shuttingDown = false;

export async function gracefulShutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`🛑 Graceful shutdown started: ${reason}`);

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
    releaseProcessLock();
  } catch {
    // swallow
  }

  await new Promise((r) => setTimeout(r, 150));
  console.log('✅ Graceful shutdown completed');
}
