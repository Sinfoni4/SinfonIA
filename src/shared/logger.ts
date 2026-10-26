import pino from 'pino';

import type { AppConfig } from '../config/config.js';

export type AppLogger = ReturnType<typeof createLogger>;

export function createLogger(config: Pick<AppConfig, 'NODE_ENV' | 'SERVICE_NAME'>) {
  return pino({
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    base: {
      service: config.SERVICE_NAME,
      environment: config.NODE_ENV,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'headers.authorization',
        '*.authorization',
        '*.token',
        '*.apiKey',
        '*.secret',
        '*.password',
        '*.email',
        '*.telegramId',
        '*.artistName',
        '*.input',
        '*.text',
      ],
      censor: '[REDACTED]',
    },
  });
}
