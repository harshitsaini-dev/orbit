import type { ProviderId } from '@orbit/shared-types';
import { ProviderError } from './base.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: BodyInit;
  /** Parsed and appended; undefined values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
  }
  // Exponential with jitter, so a fleet of clients does not retry in lockstep.
  return Math.min(2 ** attempt * 250 + Math.random() * 250, 8_000);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One fetch wrapper for every adapter. Retries the failures that are worth
 * retrying, and turns everything else into a ProviderError whose message never
 * carries credential material - provider error bodies are quoted, but the
 * request headers that held the token are not.
 */
export async function providerFetch(
  provider: ProviderId,
  url: string,
  options: RequestOptions = {},
): Promise<Response> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) target.searchParams.set(key, String(value));
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(target, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
        signal: options.signal,
      });
    } catch (err) {
      // Network-level failure: worth one more try unless the caller aborted.
      if (options.signal?.aborted) throw err;
      lastError = err;
      if (attempt === MAX_ATTEMPTS - 1) break;
      await sleep(backoffMs(attempt, null));
      continue;
    }

    if (response.ok) return response;

    if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
      await sleep(backoffMs(attempt, response.headers.get('retry-after')));
      continue;
    }

    throw new ProviderError(provider, response.status, await describe(response));
  }

  throw new ProviderError(
    provider,
    0,
    lastError instanceof Error ? lastError.message : 'Request failed after retries',
  );
}

/** Pulls a useful message out of a provider error body without dumping the lot. */
async function describe(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return response.statusText || 'Request failed';

  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; errors?: Array<{ message?: string }> } | string;
      message?: string;
      error_description?: string;
    };
    if (typeof parsed.error === 'string') return parsed.error_description ?? parsed.error;
    return (
      parsed.error?.message ??
      parsed.error?.errors?.[0]?.message ??
      parsed.message ??
      text.slice(0, 300)
    );
  } catch {
    return text.slice(0, 300);
  }
}

export async function providerJson<T>(
  provider: ProviderId,
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await providerFetch(provider, url, options);
  return (await response.json()) as T;
}
