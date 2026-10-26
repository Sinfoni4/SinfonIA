import { errorLabel } from '../../shared/errors.js';

import type { DomainCommand, DomainContext, DomainModule } from '../domain.module.js';

export const demoModule: DomainModule = {
  name: 'demo',

  actions: [],

  resolve(input: string): DomainCommand | null {
    const lower = input.toLowerCase().trim();

    // Pattern semplice per test
    if (lower === 'demo test') {
      return {
        type: 'DEMO_TEST',
        payload: {},
      };
    }

    return null;
  },

  execute(command: DomainCommand): Promise<unknown> {
    try {
      console.log('🧪 DEMO MODULE — execute');

      switch (command.type) {
        case 'DEMO_TEST':
          return Promise.resolve({
            message: '🧪 Demo module attivo (test)',
          });

        default:
          return Promise.resolve(null);
      }
    } catch (err) {
      console.error('❌ DEMO MODULE ERROR', errorLabel(err));
      return Promise.resolve({
        message: '⚠️ Errore interno modulo demo',
      });
    }
  },

  getContext(): Promise<DomainContext> {
    return Promise.resolve({});
  },
};
