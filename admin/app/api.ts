const BASE = '/api/v1';

const STATUS_MESSAGES: Record<number, string> = {
  401: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại',
  403: 'Bạn không có quyền thực hiện thao tác này',
  404: 'Không tìm thấy dữ liệu yêu cầu',
  413: 'Dữ liệu gửi lên quá lớn',
  429: 'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút',
};

/** Builds a readable Vietnamese message from a NestJS error body, falling back to the HTTP status. */
function errorMessage(status: number, body: { message?: unknown }): string {
  if (status === 429) return STATUS_MESSAGES[429];
  const msg = body.message;
  // class-validator returns an array of field errors
  if (Array.isArray(msg) && msg.length) return `Dữ liệu nhập chưa hợp lệ: ${msg.join('; ')}`;
  if (typeof msg === 'string' && msg && !/^(Unauthorized|Forbidden|Not Found|Bad Request)$/i.test(msg)) return msg;
  if (status >= 500) return 'Máy chủ đang gặp sự cố, vui lòng thử lại sau';
  return STATUS_MESSAGES[status] ?? `Yêu cầu thất bại (mã ${status})`;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      credentials: 'include',
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    });
  } catch {
    throw new Error('Không kết nối được máy chủ, vui lòng kiểm tra mạng và thử lại');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      const here = window.location.pathname;
      const area = here.startsWith('/app') ? '/app' : '/admin';
      if (!here.endsWith('/login') && !here.endsWith('/setup')) window.location.href = `${area}/login`;
    }
    throw new Error(errorMessage(res.status, body));
  }
  return res.json();
}
