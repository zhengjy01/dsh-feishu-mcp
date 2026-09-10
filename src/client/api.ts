/**
 * Browser-side API client for the /api/dsh-feishu route family.
 * The only data access path the settings panel uses — plain fetch, same origin.
 */

/** Public config view (mirrors the host contract). */
export interface FeishuConfigView {
  configured: boolean
  appIdMasked: string
  hasAppSecret: boolean
  hasUserToken: boolean
  userTokenExpiresAt: number
  userRefreshExpiresAt: number
  scope: string
  domain: string
  tokenUpdatedAt: string
  configPath: string
  connected: boolean
  toolCount: number
}

/** OAuth start result. */
export interface FeishuOAuthStartResult {
  ok: boolean
  authorizeUrl?: string
  state?: string
  callbackUrl?: string
  error?: string
}

/** OAuth finish / refresh result. */
export interface FeishuOAuthActionResult {
  ok: boolean
  message: string
}

/** Test result. */
export interface FeishuTestResult {
  ok: boolean
  message: string
  connected: boolean
  toolCount: number
  tools: string[]
}

/** Error carrying the route's JSON error message. */
export class FeishuApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeishuApiError'
  }
}

/** Parse a JSON response or throw a FeishuApiError. */
async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new FeishuApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${response.status}`
    throw new FeishuApiError(message)
  }
  return body as T
}

/** Plain fetch helper with an error wrapper. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    throw new FeishuApiError('网络请求失败: ' + String(error instanceof Error ? error.message : error))
  }
  return readJson<T>(response)
}

/** The Feishu panel API. */
export class FeishuApi {
  async getStatus(): Promise<FeishuConfigView> {
    return request<FeishuConfigView>('/api/dsh-feishu/status')
  }

  async setConfig(patch: Record<string, unknown>): Promise<FeishuConfigView> {
    return request<FeishuConfigView>('/api/dsh-feishu/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  }

  async reset(): Promise<FeishuConfigView> {
    return request<FeishuConfigView>('/api/dsh-feishu/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    })
  }

  async test(): Promise<FeishuTestResult> {
    return request<FeishuTestResult>('/api/dsh-feishu/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  }

  async oauthStart(): Promise<FeishuOAuthStartResult> {
    return request<FeishuOAuthStartResult>('/api/dsh-feishu/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  }

  async oauthFinish(code: string, state?: string): Promise<FeishuOAuthActionResult> {
    return request<FeishuOAuthActionResult>('/api/dsh-feishu/oauth/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, ...(state !== undefined && state !== '' ? { state } : {}) }),
    })
  }

  async oauthRefresh(): Promise<FeishuOAuthActionResult> {
    return request<FeishuOAuthActionResult>('/api/dsh-feishu/oauth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  }
}
