import { runtimeState } from './runtime.state.js';

export function requireDatabase() {
  requireOperationalDatabase();
}

export function requireOperationalDatabase() {
  if (runtimeState.getMode() === 'CIRCUIT_OPEN') {
    const err = new Error('DATABASE_OFFLINE');
    (err as Error & { code?: string }).code = 'DATABASE_OFFLINE';
    throw err;
  }
}
