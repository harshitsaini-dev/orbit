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

    /*
     * fetch rejects with a bare TypeError when the request never reached the
     * server at all - no network, DNS failure, the API not running, or the
     * connection dropped part-way through. Status 0 carries that through as
     * something callers can branch on, the same way they branch on any other
     * status.
     *
     * The most common cause here is not a broken network: it is the API
     * restarting after a deploy, which takes under a minute. Saying so turns
     * "it is broken" into "try again in a moment", which is both truer and
     * more useful.
     */
    throw new ApiError(
      0,
      'network_error',
      navigator.onLine
        ? 'Could not reach Orbit — it may be restarting after an update. Try again in a moment.'
        : 'Could not reach Orbit — this device is offline.',
    );
  }

  if (res.status === 204) return undefined as T;

  const payload: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;

    /*
     * A gateway failure has no JSON body to read a message out of - it comes
     * from the proxy in front of Orbit, as HTML, so `error` is undefined and
     * the message used to be the useless "Request failed".
     *
     * 504 and 524 in particular mean the request was cut for taking too long,
     * which for anything working through a list means some of it may well have
     * happened. Saying that is the difference between a safe retry and a
     * reader assuming nothing occurred.
     */
    if (!error && res.status >= 502 && res.status <= 524) {
      throw new ApiError(
        res.status,
        'gateway',
        res.status === 502 || res.status === 503
          ? 'Orbit is restarting after an update. Try again in a moment.'
          : 'That took too long and was cut off. Some of it may have gone through — refresh before retrying.',
      );
    }

    throw new ApiError(res.status, error?.code ?? 'unknown', error?.message ?? 'Request failed');
  }

  return payload as T;
}
