/**
 * Minimal client for the WhatsApp Business Cloud API (Meta Graph API): text and document
 * messages, media upload and download.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
// WhatsApp rejects text messages longer than 4096 characters.
const MAX_TEXT_LENGTH = 4096;

export type WhatsAppClientOptions = {
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
};

/** Error returned by the Graph API; `code` is Meta's error code (e.g. 131047: 24-hour window). */
export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

type GraphError = { error?: { message?: string; code?: number } };

export class WhatsAppClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WhatsAppClientOptions) {
    this.base = `${options.apiBase ?? 'https://graph.facebook.com'}/${options.apiVersion ?? 'v21.0'}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendText(to: string, body: string): Promise<void> {
    const text = body.length > MAX_TEXT_LENGTH ? `${body.slice(0, MAX_TEXT_LENGTH - 1)}…` : body;
    await this.postMessage({
      to,
      type: 'text',
      text: { body: text, preview_url: false },
    });
  }

  /** Uploads the file to Meta and sends it as a document message. */
  async sendDocument(
    to: string,
    document: { filename: string; content: Buffer; mimeType: string },
    caption?: string,
  ): Promise<void> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', document.mimeType);
    form.append(
      'file',
      new Blob([new Uint8Array(document.content)], { type: document.mimeType }),
      document.filename,
    );
    const upload = await this.request<{ id: string }>(
      `${this.base}/${this.options.phoneNumberId}/media`,
      { method: 'POST', body: form },
      'media upload',
    );
    await this.postMessage({
      to,
      type: 'document',
      document: { id: upload.id, filename: document.filename, ...(caption ? { caption } : {}) },
    });
  }

  /** Metadata of a received media item (image, document). */
  async getMedia(mediaId: string): Promise<{ url: string; mimeType?: string; fileSize?: number }> {
    const media = await this.request<{ url: string; mime_type?: string; file_size?: number }>(
      `${this.base}/${encodeURIComponent(mediaId)}`,
      { method: 'GET' },
      'media lookup',
    );
    return { url: media.url, mimeType: media.mime_type, fileSize: media.file_size };
  }

  /** Downloads a media URL returned by getMedia (it requires the access token as well). */
  async downloadMedia(url: string): Promise<Buffer> {
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.options.accessToken}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new WhatsAppApiError(
        `WhatsApp media download failed (${response.status})`,
        response.status,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async postMessage(message: Record<string, unknown>): Promise<void> {
    await this.request(
      `${this.base}/${this.options.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          ...message,
        }),
      },
      'send message',
    );
  }

  private async request<T>(url: string, init: RequestInit, action: string): Promise<T> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${this.options.accessToken}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => ({}))) as T & GraphError;
    if (!response.ok || payload.error) {
      throw new WhatsAppApiError(
        `WhatsApp ${action} failed (${payload.error?.code ?? response.status}): ${
          payload.error?.message ?? 'unknown error'
        }`,
        response.status,
        payload.error?.code,
      );
    }
    return payload;
  }
}
