import { errorLabel } from '../../shared/errors.js';
import { log } from '../../shared/log.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
// A Bot API call that never answers must not block its caller (e.g. the outbox dispatcher).
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};

export type TelegramDocument = {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

export type TelegramMessage = {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  chat: {
    id: number;
    type: string;
  };
  from?: {
    id: number;
    is_bot: boolean;
    first_name?: string;
    username?: string;
  };
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
};

/** Error returned by the Bot API; `retryAfterSeconds` is set on 429 (flood control). */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly errorCode: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

type Listener = (value: TelegramMessage | Error) => void | Promise<void>;

export type SendMessageOptions = {
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  disable_web_page_preview?: boolean;
  disable_notification?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramClient {
  private readonly listeners = new Map<string, Set<Listener>>();
  private polling = false;
  private offset = 0;
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly token: string) {}

  on(event: 'message', listener: (message: TelegramMessage) => void | Promise<void>): this;
  on(
    event: 'polling_error' | 'webhook_error' | 'error',
    listener: (error: Error) => void | Promise<void>,
  ): this;
  on(
    event: string,
    listener:
      | ((message: TelegramMessage) => void | Promise<void>)
      | ((error: Error) => void | Promise<void>),
  ): this {
    const bucket = this.listeners.get(event) ?? new Set<Listener>();
    bucket.add(listener as Listener);
    this.listeners.set(event, bucket);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  async sendMessage(
    chatId: number | string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<TelegramMessage> {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...options,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    return this.parseResult<TelegramMessage>('sendMessage', response);
  }

  /** Sends a file (e.g. a CSV export) as a document. */
  async sendDocument(
    chatId: number | string,
    document: { filename: string; content: Buffer; mimeType: string },
    options: { caption?: string } = {},
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append(
      'document',
      new Blob([new Uint8Array(document.content)], { type: document.mimeType }),
      document.filename,
    );
    if (options.caption) {
      form.append('caption', options.caption);
    }

    const response = await fetch(`${TELEGRAM_API_BASE}/bot${this.token}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return this.parseResult<TelegramMessage>('sendDocument', response);
  }

  private async parseResult<T>(method: string, response: Response): Promise<T> {
    const payload = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !payload.ok || !payload.result) {
      throw new TelegramApiError(
        `Telegram ${method} failed (${payload.error_code ?? response.status}): ${
          payload.description ?? 'unknown error'
        }`,
        payload.error_code ?? response.status,
        payload.parameters?.retry_after,
      );
    }
    return payload.result;
  }

  async getFile(
    fileId: string,
  ): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
    const response = await fetch(
      `${TELEGRAM_API_BASE}/bot${this.token}/getFile?file_id=${fileId}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    const payload = (await response.json()) as TelegramResponse<{
      file_id: string;
      file_path?: string;
      file_size?: number;
    }>;
    if (!response.ok || !payload.ok || !payload.result) {
      throw new Error(`Telegram getFile failed: ${payload.description ?? 'unknown error'}`);
    }
    return payload.result;
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const response = await fetch(`${TELEGRAM_API_BASE}/file/bot${this.token}/${filePath}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Telegram downloadFile failed: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  startPolling(): Promise<void> {
    if (this.polling) return this.loopPromise ?? Promise.resolve();

    this.polling = true;
    this.abortController = new AbortController();
    this.loopPromise = this.pollLoop().finally(() => {
      this.polling = false;
      this.abortController = null;
    });
    return this.loopPromise;
  }

  async stopPolling(): Promise<void> {
    this.polling = false;
    this.abortController?.abort();
    await this.loopPromise?.catch(() => undefined);
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          if (update.message) {
            await this.emit('message', update.message);
          }
        }
      } catch (error: unknown) {
        if (!this.polling) return;
        await this.emit('polling_error', toError(error));
        await sleep(1_000);
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const url = new URL(`${TELEGRAM_API_BASE}/bot${this.token}/getUpdates`);
    url.searchParams.set('timeout', '25');
    url.searchParams.set('offset', String(this.offset));

    const response = await fetch(url, {
      signal: this.abortController?.signal,
    });
    const payload = (await response.json()) as TelegramResponse<TelegramUpdate[]>;

    if (!response.ok || !payload.ok || !Array.isArray(payload.result)) {
      throw new Error(
        `Telegram getUpdates failed (${payload.error_code ?? response.status}): ${
          payload.description ?? 'unknown error'
        }`,
      );
    }

    return payload.result;
  }

  private async emit(event: string, value: TelegramMessage | Error): Promise<void> {
    const bucket = this.listeners.get(event);
    if (!bucket) return;

    for (const listener of bucket) {
      try {
        await listener(value);
      } catch (error: unknown) {
        if (event !== 'error') {
          await this.emit('error', toError(error));
        } else {
          log.error({ error: errorLabel(toError(error)) }, 'Telegram listener error');
        }
      }
    }
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
