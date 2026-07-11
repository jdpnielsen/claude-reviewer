// Shared client-side fetch helper for talking to this app's own /api/* routes.
// Every API route returns errors as `{ error: string }` on non-2xx responses -
// ApiError surfaces that message consistently instead of each call site
// re-deriving it (or, in a few pre-existing call sites, not checking at all).

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const data: unknown = await res.clone().json();
    if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
      return data.error;
    }
  } catch {
    // Body wasn't JSON (or was empty) - fall back to statusText below.
  }
  return res.statusText || `Request failed with status ${res.status}`;
}

async function parseResponseBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;
  const hasJsonBody = body !== undefined && typeof body !== 'string';

  const res = await fetch(path, {
    ...rest,
    headers: {
      ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: hasJsonBody ? JSON.stringify(body) : (body as BodyInit | undefined),
  });

  if (!res.ok) {
    throw new ApiError(await extractErrorMessage(res), res.status);
  }

  return parseResponseBody<T>(res);
}

export const apiClient = {
  get: <T>(path: string, options?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...options, method: 'DELETE' }),
};

// Builds a `?a=1&b=2` query string, dropping null/undefined/empty values so
// callers don't need to hand-manage `encodeURIComponent` + string concatenation.
export function buildQuery(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}
