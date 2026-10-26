/**
 * OpenAI-compatible HTTP provider for the interpreter.
 * Uses fetch + env config. Isolated from executor/workflow/data.
 */

import type { LLMClient } from '../interpreter/interpreter.service.js';

export type OpenAIProviderConfig = {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAIProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retried?: boolean,
  ) {
    super(message);
    this.name = 'OpenAIProviderError';
  }
}

/**
 * Builds an LLMClient that calls OpenAI (or compatible) chat completions API.
 * - Timeout to avoid hanging
 * - Retry on 429/5xx with exponential backoff
 * - Clear errors for logging/triage
 */
export function createOpenAIProvider(config: OpenAIProviderConfig): LLMClient {
  const {
    apiKey,
    model = DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = config;

  async function complete(prompt: string): Promise<string> {
    const url = 'https://api.openai.com/v1/chat/completions';
    const body = {
      model,
      messages: [
        {
          role: 'system' as const,
          content: 'You output only valid JSON. No markdown, no explanation.',
        },
        { role: 'user' as const, content: prompt },
      ],
      max_tokens: 512,
      temperature: 0,
    };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const data = (await res.json()) as {
          error?: { message?: string };
          choices?: Array<{ message?: { content?: string } }>;
        };

        if (!res.ok) {
          const msg = data?.error?.message ?? res.statusText;
          const err = new OpenAIProviderError(
            `OpenAI API error: ${res.status} ${msg}`,
            res.status,
            attempt > 0,
          );
          if (res.status === 429 || res.status >= 500) {
            lastError = err;
            await sleep(500 * Math.pow(2, attempt));
            continue;
          }
          throw err;
        }

        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text == null || text === '') {
          throw new OpenAIProviderError('OpenAI returned empty content');
        }
        return text;
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        if (err instanceof OpenAIProviderError) {
          lastError = err;
          if (err.statusCode === 429 || (err.statusCode != null && err.statusCode >= 500)) {
            await sleep(500 * Math.pow(2, attempt));
            continue;
          }
          throw err;
        }
        if (err instanceof Error) {
          if (err.name === 'AbortError') {
            throw new OpenAIProviderError(`Request timeout after ${timeoutMs}ms`);
          }
          lastError = err;
          if (attempt < maxRetries) {
            await sleep(500 * Math.pow(2, attempt));
            continue;
          }
          throw new OpenAIProviderError(`Request failed: ${err.message}`, undefined, true);
        }
        throw err;
      }
    }

    throw lastError ?? new OpenAIProviderError('Max retries exceeded', undefined, true);
  }

  return { complete, mode: 'real' };
}
