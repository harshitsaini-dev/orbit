const BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Every call sends the session cookie. Errors arrive as ApiError so callers can
 * branch on `code` rather than parsing messages.
 */
export async function api<T>(path: string, options: Options = {}): Promise<T> {
  let res: Response;

  try {
    res = await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'include',
      signal: options.signal,
      headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (err) {
    // An aborted request is the caller's own doing and must stay distinguishable
    // from a failure, or every navigation would look like the network broke.
    if (err instanceof Error && err.name === 'AbortError') throw err;

    // fetch rejects with a bare TypeError when the request never reached the
    // server at all - no network, DNS failure, the API not running. Status 0
    // carries that through as something callers can branch on, the same way
    // they branch on any other status.
    throw new ApiError(0, 'network_error', 'Could not reach Orbit');
  }

  if (res.status === 204) return undefined as T;

  const payload: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, error?.code ?? 'unknown', error?.message ?? 'Request failed');
  }

  return payload as T;
}
