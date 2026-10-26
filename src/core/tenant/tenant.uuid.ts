import { createHash } from 'node:crypto';

/**
 * Deterministic UUID v4-shaped id from a stable seed (same strategy as TelegramAdapter).
 * Used for demo tenant id and mapping Telegram chat id → DB user id.
 */
export function uuidFromSeed(seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
