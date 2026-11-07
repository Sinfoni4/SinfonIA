import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Telegram Mini App: the data Telegram passes to the app when it opens (`initData`, the query
 * string of `tgWebAppData`), signed with the bot token
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 * secret = HMAC-SHA256(key "WebAppData", bot token); hash = HMAC-SHA256(secret, the other fields
 * sorted, `key=value` one per line). Only the numeric id of the user is used, never names.
 */

export class TelegramWebAppError extends Error {
  readonly statusCode = 401;
  readonly code = 'TELEGRAM_WEBAPP_INVALID';
  constructor() {
    super('Apri SinfonIA dalla chat di Telegram');
    this.name = 'TelegramWebAppError';
  }
}

/** How long the data of an opening stays valid: a stolen link cannot be reused later. */
export const WEBAPP_MAX_AGE_SECONDS = 60 * 60;

function secretOf(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest();
}

function checkString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
}

/** The numeric Telegram id of whoever opened the Mini App, when the data is genuine and recent. */
export function verifyWebAppInitData(
  initData: string,
  botToken: string,
  now: Date = new Date(),
  maxAgeSeconds = WEBAPP_MAX_AGE_SECONDS,
): { telegramId: string } {
  if (!botToken || !initData || initData.length > 4096) throw new TelegramWebAppError();
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') ?? '';
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new TelegramWebAppError();
  const expected = createHmac('sha256', secretOf(botToken)).update(checkString(params)).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw new TelegramWebAppError();

  const authDate = Number(params.get('auth_date'));
  const age = now.getTime() / 1000 - authDate;
  if (!Number.isFinite(authDate) || age > maxAgeSeconds || age < -60) {
    throw new TelegramWebAppError();
  }
  let id: unknown;
  try {
    id = (JSON.parse(params.get('user') ?? '{}') as { id?: unknown }).id;
  } catch {
    throw new TelegramWebAppError();
  }
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new TelegramWebAppError();
  }
  return { telegramId: String(id) };
}

/**
 * Signs data the way Telegram does. For tests, and for the development preview in a browser
 * (outside Telegram), which only a development server offers.
 */
export function signWebAppInitData(
  botToken: string,
  telegramId: string,
  now: Date = new Date(),
): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(Math.floor(now.getTime() / 1000)));
  params.set('query_id', `dev-${now.getTime()}`);
  params.set('user', JSON.stringify({ id: Number(telegramId), first_name: 'Anteprima' }));
  const hash = createHmac('sha256', secretOf(botToken)).update(checkString(params)).digest('hex');
  params.set('hash', hash);
  return params.toString();
}
