/**
 * OpenAI-compatible HTTP provider for the interpreter.
 * Uses fetch + env config. Isolated from executor/workflow/data.
 */

import type { LLMClient, LLMCompletionResult } from '../interpreter/interpreter.service.js';

export type OpenAIProviderConfig = {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Chat completions URL; OpenAI by default. */
  endpointUrl?: string;
  /** Authentication header; OpenAI uses a bearer token, Azure an "api-key" header. */
  authHeaders?: Record<string, string>;
  providerName?: string;
};

export type AzureOpenAIProviderConfig = {
  apiKey: string;
  /** Resource endpoint, e.g. https://<resource>.openai.azure.com (choose an EU region). */
  endpoint: string;
  /** Deployment name of the model in the Azure resource. */
  deployment: string;
  apiVersion?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

export type MistralProviderConfig = {
  apiKey: string;
  /** Mistral model, e.g. mistral-small-latest. */
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

const DEFAULT_MODEL = 'gpt-4o-mini';
export const DEFAULT_MISTRAL_MODEL = 'mistral-small-latest';
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
 * - Detailed usage token and model tracing
 * - Clear errors for logging/triage
 */
export function createOpenAIProvider(config: OpenAIProviderConfig): LLMClient {
  const {
    apiKey,
    model = DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    endpointUrl = 'https://api.openai.com/v1/chat/completions',
    authHeaders = { Authorization: `Bearer ${apiKey}` },
    providerName = 'openai',
  } = config;

  async function completeDetailed(prompt: string): Promise<LLMCompletionResult> {
    const url = endpointUrl;
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
      response_format: { type: 'json_object' as const },
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
            ...authHeaders,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const data = (await res.json()) as {
          error?: { message?: string };
          choices?: Array<{ message?: { content?: string } }>;
          model?: string;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };

        if (!res.ok) {
          const msg = data?.error?.message ?? res.statusText;
          const err = new OpenAIProviderError(
            `${providerName} API error: ${res.status} ${msg}`,
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
          throw new OpenAIProviderError(`${providerName} returned empty content`);
        }

        return {
          text,
          model: data.model ?? model,
          provider: providerName,
          usage: data.usage
            ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
              }
            : undefined,
        };
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

  async function complete(prompt: string): Promise<string> {
    const res = await completeDetailed(prompt);
    return res.text;
  }

  return {
    complete,
    completeDetailed,
    mode: 'real',
    model,
    providerName,
  };
}

/**
 * Azure OpenAI: same chat completions API, served from an Azure resource in a chosen region
 * (e.g. Sweden Central, France Central) so prompts stay in the EU under the Azure DPA.
 */
export function createAzureOpenAIProvider(config: AzureOpenAIProviderConfig): LLMClient {
  const endpoint = config.endpoint.replace(/\/+$/, '');
  return createOpenAIProvider({
    apiKey: config.apiKey,
    // The deployment determines the model; the name is only reported in traces.
    model: config.deployment,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    endpointUrl: `${endpoint}/openai/deployments/${encodeURIComponent(config.deployment)}/chat/completions?api-version=${encodeURIComponent(config.apiVersion ?? '2024-10-21')}`,
    authHeaders: { 'api-key': config.apiKey },
    providerName: 'azure-openai',
  });
}

/**
 * Mistral AI (La Plateforme): same chat completions format and JSON mode, served by a European
 * company from EU infrastructure by default. Data retention terms are in Mistral's DPA.
 */
export function createMistralProvider(config: MistralProviderConfig): LLMClient {
  return createOpenAIProvider({
    apiKey: config.apiKey,
    model: config.model ?? DEFAULT_MISTRAL_MODEL,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    endpointUrl: 'https://api.mistral.ai/v1/chat/completions',
    providerName: 'mistral',
  });
}
