import { errorLabel } from '../shared/errors.js';
import { log } from '../shared/log.js';

import { gracefulShutdown } from './runtime.shutdown.js';

function shutdownAndExit(reason: string, exitCode?: number): void {
  void gracefulShutdown(reason)
    .catch((error: unknown) => {
      log.error({ error: errorLabel(error) }, 'Graceful shutdown failed');
    })
    .finally(() => {
      if (exitCode !== undefined) process.exit(exitCode);
    });
}

export function installLifecycleHooks() {
  process.once('SIGINT', () => {
    shutdownAndExit('signal', 0);
  });

  process.once('SIGTERM', () => {
    shutdownAndExit('signal', 0);
  });

  process.once('SIGUSR2', () => {
    void gracefulShutdown('nodemon')
      .catch((error: unknown) => {
        log.error({ error: errorLabel(error) }, 'Graceful shutdown failed');
      })
      .finally(() => {
        setTimeout(() => process.exit(0), 200);
      });
  });

  process.once('beforeExit', () => {
    void gracefulShutdown('beforeExit').catch((error: unknown) => {
      log.error({ error: errorLabel(error) }, 'Graceful shutdown failed');
    });
  });

  process.once('uncaughtException', (error: unknown) => {
    log.fatal({ error: errorLabel(error) }, 'Unhandled exception');
    shutdownAndExit('fatal', 1);
  });

  process.once('unhandledRejection', (reason: unknown) => {
    log.fatal({ error: errorLabel(reason) }, 'Unhandled rejection');
    shutdownAndExit('fatal', 1);
  });
}
