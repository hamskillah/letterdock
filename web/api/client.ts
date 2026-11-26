export class AccessError extends Error {
  constructor(message = 'Sign in required') {
    super(message);
    this.name = 'AccessError';
  }
}

export async function api<T>(
  path: string,
  method = 'GET',
  data?: unknown,
  options?: { signal?: AbortSignal; priority?: RequestPriority }
): Promise<T> {
  const url = path.startsWith('/api') ? path : '/api' + path;
  const response = await fetch(url, {
    ...options,
    method,
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data)
  });

  const result = await response.json().catch(() => null);

  if (response.status === 401) {
    throw new AccessError(result?.message ?? 'Sign in required');
  }

  if (!response.ok) {
    throw new Error(result?.message ?? 'Request failed. Try again.');
  }

  return result as T;
}

export const when = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));

export const emailDate = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric'
});

export const senderName = (value: string) =>
  value.match(/^(.+?)\s*<[^>]+>$/)?.[1]?.replace(/^"|"$/g, '') || value || 'Unknown sender';
