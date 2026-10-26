import { errorLabel } from '../shared/errors.js';

import { gracefulShutdown } from './runtime.shutdown.js';

function shutdownAndExit(reason: string, exitCode?: number): void {
  void gracefulShutdown(reason)
    .catch((error: unknown) => {
      console.error('Graceful shutdown failed:', errorLabel(error));
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
    console.log('♻️ Nodemon restart requested');
    void gracefulShutdown('nodemon')
      .catch((error: unknown) => {
        console.error('Graceful shutdown failed:', errorLabel(error));
      })
      .finally(() => {
        setTimeout(() => process.exit(0), 200);
      });
  });

  process.once('beforeExit', () => {
    void gracefulShutdown('beforeExit').catch((error: unknown) => {
      console.error('Graceful shutdown failed:', errorLabel(error));
    });
  });

  process.once('uncaughtException', (error: unknown) => {
    console.error('Unhandled exception:', errorLabel(error));
    shutdownAndExit('fatal', 1);
  });

  process.once('unhandledRejection', (reason: unknown) => {
    console.error('Unhandled rejection:', errorLabel(reason));
    shutdownAndExit('fatal', 1);
  });
}
