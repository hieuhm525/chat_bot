const BASE = '/api/v1';

const STATUS_MESSAGES: Record<number, string> = {
  401: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại',
  403: 'Bạn không có quyền thực hiện thao tác này',
  404: 'Không tìm thấy dữ liệu yêu cầu',
  413: 'Dữ liệu gửi lên quá lớn',
  429: 'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút',
};

/** status 0 means the request never reached the server (offline, DNS, CORS...). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Per-field messages when the server returns `errors: [{ field, message }]`. */
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  message?: unknown;
  errors?: unknown;
}

/** Builds a readable Vietnamese message from a NestJS error body, falling back to the HTTP status. */
function errorMessage(status: number, body: ErrorBody): string {
  if (status === 429) return STATUS_MESSAGES[429];
  const msg = body.message;
  // class-validator returns an array of field errors
  if (Array.isArray(msg) && msg.length) return `Dữ liệu nhập chưa hợp lệ: ${msg.join('; ')}`;
  if (typeof msg === 'string' && msg && !/^(Unauthorized|Forbidden|Not Found|Bad Request)$/i.test(msg)) return msg;
  if (status >= 500) return 'Máy chủ đang gặp sự cố, vui lòng thử lại sau';
  return STATUS_MESSAGES[status] ?? `Yêu cầu thất bại (mã ${status})`;
}

function fieldErrors(body: ErrorBody): Record<string, string> {
  if (!Array.isArray(body.errors)) return {};
  const out: Record<string, string> = {};
  for (const e of body.errors) {
    if (e && typeof e.field === 'string' && typeof e.message === 'string') out[e.field] = e.message;
  }
  return out;
}

/** The area ('/app' or '/admin') the browser is in; each area is its own router basename. */
export function currentArea(): '/app' | '/admin' {
  return window.location.pathname.startsWith('/app') ? '/app' : '/admin';
}

/**
 * Accepts only a same-area path such as "/bots/1?x=y". Anything else (absolute URL,
 * protocol-relative "//evil", backslashes, the login page itself) falls back to "/".
 */
export function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  if (/^\/(login|register|setup)(\/|\?|$)/.test(raw)) return '/';
  return raw;
}

/** Path inside the current area, used as `?next=` so login can bring the user back. */
export function currentPathInArea(): string {
  const area = currentArea();
  const path = window.location.pathname.slice(area.length) || '/';
  return path + window.location.search;
}

export interface ApiInit extends RequestInit {
  /** Set false when a 401 is an expected answer (e.g. checking whether anyone is logged in). */
  redirectOn401?: boolean;
}

export async function api<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  const { redirectOn401 = true, ...fetchInit } = init;
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      credentials: 'include',
      headers: fetchInit.body ? { 'Content-Type': 'application/json' } : undefined,
      ...fetchInit,
    });
  } catch (err) {
    console.error(`Gọi ${fetchInit.method ?? 'GET'} ${BASE + path} không tới được máy chủ`, err);
    throw new ApiError('Không kết nối được máy chủ, vui lòng kiểm tra mạng và thử lại', 0);
  }
  if (!res.ok) {
    const body: ErrorBody = await res.json().catch((err: unknown) => {
      console.warn(`Body lỗi của ${BASE + path} (HTTP ${res.status}) không phải JSON`, err);
      return {};
    });
    if (res.status === 401 && redirectOn401) {
      const here = window.location.pathname;
      if (!here.endsWith('/login') && !here.endsWith('/setup')) {
        const next = currentPathInArea();
        const query = next === '/' ? '' : `?next=${encodeURIComponent(next)}`;
        window.location.href = `${currentArea()}/login${query}`;
      }
    }
    throw new ApiError(errorMessage(res.status, body), res.status, fieldErrors(body));
  }
  return res.json();
}
