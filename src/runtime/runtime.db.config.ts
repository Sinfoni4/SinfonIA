import { log } from '../shared/log.js';

export function validateDatabaseConfig() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    log.error('DATABASE_URL missing');
    return {
      valid: false,
      reason: 'DATABASE_URL_UNDEFINED',
    };
  }

  return { valid: true, reason: null as string | null };
}
