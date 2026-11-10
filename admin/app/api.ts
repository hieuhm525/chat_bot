const BASE = '/api/v1';

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: 'include',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (res.status === 401) {
    const path = window.location.pathname;
    const area = path.startsWith('/app') ? '/app' : '/admin';
    if (!path.endsWith('/login') && !path.endsWith('/setup')) window.location.href = `${area}/login`;
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  return res.json();
}
