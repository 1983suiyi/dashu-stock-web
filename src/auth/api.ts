/**
 * 账号接口请求封装：统一处理 { ok, error } 包装与 CSRF 头。
 * 同源部署下 Cookie 自动携带（credentials: same-origin）。
 */

export type ApiError = { code: string; message: string }
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError }

const CSRF_HEADER = { 'X-Requested-With': 'XMLHttpRequest' }

const request = async <T>(
  path: string,
  init: RequestInit,
): Promise<ApiResult<T>> => {
  try {
    const response = await fetch(path, { credentials: 'same-origin', ...init })
    const raw = await response.text()
    const payload = raw ? JSON.parse(raw) : {}
    if (response.ok && payload?.ok) {
      return { ok: true, data: payload.data as T }
    }
    const error: ApiError = payload?.error ?? {
      code: 'REQUEST_FAILED',
      message: `请求失败（${response.status}）`,
    }
    return { ok: false, error }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : '网络异常',
      },
    }
  }
}

export const apiGet = <T>(path: string) =>
  request<T>(path, { method: 'GET', headers: { ...CSRF_HEADER } })

export const apiSend = <T>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
) =>
  request<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...CSRF_HEADER },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
