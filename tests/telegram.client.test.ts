import { afterEach, describe, expect, it, vi } from 'vitest';

import { TelegramClient } from '../src/interface/telegram/telegram.client.js';

describe('telegram client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends messages through the Bot API without the legacy package', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          result: { message_id: 1, date: 0, chat: { id: 42, type: 'private' } },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new TelegramClient('123456:test-token');
    const result = await client.sendMessage(42, 'hello');

    expect(result.message_id).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/bot123456:test-token/sendMessage');
    expect(init.method).toBe('POST');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: 42, text: 'hello' });
  });

  it('throws a sanitized error when the Bot API rejects a message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ ok: false, error_code: 401, description: 'Unauthorized' }),
      }),
    );

    const client = new TelegramClient('123456:test-token');
    await expect(client.sendMessage(42, 'hello')).rejects.toThrow(/Telegram sendMessage failed/);
  });
});
