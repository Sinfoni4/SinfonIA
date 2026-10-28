import { createLogger } from './logger.js';

const env = process.env.NODE_ENV;

/**
 * Structured logger for modules that are not handed one (runtime, transports, startup checks).
 * Same JSON format and redaction rules as the application logger.
 */
export const log = createLogger({
  NODE_ENV: env === 'production' || env === 'test' ? env : 'development',
  SERVICE_NAME: process.env.SERVICE_NAME ?? 'sinfonia',
});
