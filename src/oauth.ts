/**
 * dsh-feishu — Feishu-native OAuth 2.0 flow for the lark-mcp bridge.
 *
 * The official @larksuiteoapi/lark-mcp server authenticates to the Feishu
 * OpenAPI either as the app (tenant_access_token) or as a user
 * (user_access_token). The latter is what lets the agent reach the user's
 * private resources (personal docs, sending IM as the user, …). Previously
 * the only way to provide a user_access_token was to paste one manually.
 *
 * This module implements the browser-redirect ("跳转授权") flow that the
 * Gmail / Vercel / Cloudflare MCP plugins already expose:
 *
 *    1. `begin`      — build the Feishu authorize URL (authen/v1/authorize)
 *                      with a random CSRF `state` and the requested scope.
 *    2. code exchange — the browser redirects back to the DSH web server
 *                      (/api/dsh-feishu/oauth/callback) with `code`; we
 *                      POST it to authen/v2/oauth/token for the
 *                      user_access_token + refresh_token.
 *    3. `refresh`    — authen/v2/oauth/token (grant_type=refresh_token).
 *
 * No PKCE is used: this is a confidential web client (it holds the App
 * Secret), so `client_secret` authenticates the token requests and the
 * `state` round-trip covers CSRF. The token is handed to lark-mcp through
 * the `USER_ACCESS_TOKEN` env var (read near startup), so the supervisor
 * calls `ensureFresh()` before every spawn and reconnects when a refresh
 * lands, keeping the child in sync.
 *
 * Endpoints (Feishu CN by default; set `domain` for Lark intl):
 *   authorize:  {domain}/open-apis/authen/v1/authorize
 *   token:      {domain}/open-apis/authen/v2/oauth/token   (per RFC 6749)
 */

import { randomUUID } from 'node:crypto'
import type { FeishuStore } from './store.ts'

/** Default Feishu (China) API domain. */
export const DEFAULT_DOMAIN = 'https://open.feishu.cn'
/** Lark (international) API domain. */
export const LARK_DOMAIN = 'https://open.larksuite.com'

/** How long a pending authorization flow stays valid (ms). */
export const PENDING_FLOW_TTL_MS = 10 * 60 * 1000
/** Refresh the user_access_token this far before expiry (ms). */
export const REFRESH_SKEW_MS = 60 * 1000

/** One in-flight authorization flow (single-slot; concurrency rejected). */
export interface PendingFlow {
  state: string
  /** The redirect_uri used in the authorize request (needed for the exchange). */
  redirectUri: string
  /** Timestamp of begin(), for TTL eviction. */
  startedAt: number
}

/** Tokens returned by authen/v2/oauth/token. */
export interface FeishuTokenResult {
  access_token: string
  refresh_token: string
  /** user_access_token lifetime in seconds. */
  expires_in: number
  /** refresh_token lifetime in seconds. */
  refresh_token_expires_in: number
  token_type: string
  scope: string
}

/** Normative error text for a Feishu token-endpoint error body. */
function tokenErrorText(body: unknown): string {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const code = typeof record.error === 'string' ? record.error : typeof record.error_code === 'number' ? String(record.error_code) : ''
  const description = typeof record.error_description === 'string' ? record.error_description : ''
  const mcpCode = typeof record.code === 'number' ? record.code : ''
  const mcpMsg = typeof record.msg === 'string' ? record.msg : ''
  const parts: string[] = []
  if (mcpCode !== '' || mcpMsg !== '') parts.push(`${mcpCode}: ${mcpMsg}`.trim())
  if (code !== '' || description !== '') parts.push(`${code}${description ? ': ' + description : ''}`.trim())
  return parts.filter(Boolean).join(' · ') || '未知错误'
}

/**
 * Feishu-native OAuth orchestration shared by the routes, the agent tools,
 * and the supervisor's token refresh. `begin` builds the authorize URL;
 * `complete` exchanges the code; `refresh`/`ensureFresh` keeps the token
 * current.
 */
export class FeishuOAuthFlow {
  private pending: PendingFlow | null = null

  constructor(private readonly store: FeishuStore) {}

  /** Whether an authorization flow is currently pending (and not stale). */
  get pendingFlow(): PendingFlow | null {
    const pending = this.pending
    if (pending === null) return null
    if (Date.now() - pending.startedAt > PENDING_FLOW_TTL_MS) {
      this.pending = null
      return null
    }
    return pending
  }

  /** Abort any pending flow (used by clear/reset). */
  abort(): void {
    this.pending = null
  }

  /** Short token endpoint for the configured domain. */
  private tokenUrl(cfg: { domain?: string }): string {
    return `${cfg.domain?.trim() || DEFAULT_DOMAIN}/open-apis/authen/v2/oauth/token`
  }

  /** Short authorize URL host for the configured domain. */
  private authorizeUrl(cfg: { domain?: string }): string {
    return `${cfg.domain?.trim() || DEFAULT_DOMAIN}/open-apis/authen/v1/authorize`
  }

  /**
   * Start an authorization: validate the app credentials, generate a CSRF
   * `state`, and build the Feishu authorize URL for the browser.
   */
  async begin(callbackUrl: string, scopeOverride?: string): Promise<{ authorizeUrl: string; state: string }> {
    const cfg = await this.store.load()
    if (cfg.appId.trim() === '') throw new Error('尚未配置飞书 App ID：请先填写 App ID / App Secret。')
    if (cfg.appSecret.trim() === '') throw new Error('尚未配置飞书 App Secret：请先填写 App ID / App Secret。')
    // Allow restarting an authorization even when a prior pending flow is
    // still in the TTL window (e.g. the user closed the authorize page).
    this.pending = null
    const state = randomUUID()
    this.pending = { state, redirectUri: callbackUrl, startedAt: Date.now() }
    const scope = (scopeOverride !== undefined && scopeOverride.trim() !== '')
      ? scopeOverride.trim()
      : (cfg.scope.trim() !== '' ? cfg.scope.trim() : 'offline_access')
    const url = new URL(this.authorizeUrl(cfg))
    url.searchParams.set('client_id', cfg.appId.trim())
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', callbackUrl)
    url.searchParams.set('scope', scope)
    url.searchParams.set('state', state)
    // Always ask for consent so a refresh_token is minted (offline_access).
    url.searchParams.set('prompt', 'consent')
    return { authorizeUrl: url.toString(), state }
  }

  /**
   * Complete the flow with the authorization code (auto callback or a paste).
   * Verifies `state` (empty `state` accepts the single pending flow),
   * exchanges the code for tokens, and persists them.
   */
  async complete(code: string, state: string): Promise<{ ok: boolean; message: string }> {
    const pending = this.pendingFlow
    if (pending === null) return { ok: false, message: '没有待完成的飞书授权流程：请先发起登录授权。' }
    if (state !== '' && pending.state !== state) {
      return { ok: false, message: 'state 校验未通过（授权流程可能已过期或重复）。请重新发起登录授权。' }
    }
    this.pending = null
    const cfg = await this.store.load()
    if (cfg.appId.trim() === '' || cfg.appSecret.trim() === '') {
      return { ok: false, message: '缺少应用凭据：请先配置 App ID / App Secret。' }
    }
    try {
      const token = await this.exchange({
        grant_type: 'authorization_code',
        code,
        client_id: cfg.appId.trim(),
        client_secret: cfg.appSecret.trim(),
        redirect_uri: pending.redirectUri,
      })
      await this.store.saveUserTokens(token)
      return { ok: true, message: '授权成功：飞书 user_access_token 已保存，MCP 工具已就绪。' }
    } catch (error) {
      return { ok: false, message: '领取令牌失败：' + String(error instanceof Error ? error.message : error) }
    }
  }

  /** Force a refresh of the user_access_token (verifies the refresh flow). */
  async refreshToken(): Promise<{ ok: boolean; message: string }> {
    const cfg = await this.store.load()
    if (cfg.userRefreshToken.trim() === '') {
      return { ok: false, message: '没有 refresh_token：请重新发起登录授权（需在 scope 中保留 offline_access）。' }
    }
    if (cfg.appId.trim() === '' || cfg.appSecret.trim() === '') {
      return { ok: false, message: '缺少应用凭据：请先配置 App ID / App Secret。' }
    }
    try {
      const token = await this.exchange({
        grant_type: 'refresh_token',
        refresh_token: cfg.userRefreshToken.trim(),
        client_id: cfg.appId.trim(),
        client_secret: cfg.appSecret.trim(),
      })
      await this.store.saveUserTokens(token)
      return { ok: true, message: '刷新成功：飞书 user_access_token 已更新。' }
    } catch (error) {
      return { ok: false, message: '刷新失败：' + String(error instanceof Error ? error.message : error) }
    }
  }

  /**
   * Refresh the user_access_token if it is missing, expired, or within
   * REFRESH_SKEW_MS of expiry (and a refresh_token exists). Returns true
   * when a refresh happened — the supervisor reconnects so the spawned
   * lark-mcp picks up the new token via the USER_ACCESS_TOKEN env var.
   */
  async ensureFresh(): Promise<boolean> {
    const cfg = await this.store.load()
    if (cfg.userAccessToken.trim() === '') return false
    if (cfg.userTokenExpiresAt > 0 && cfg.userTokenExpiresAt - Date.now() > REFRESH_SKEW_MS) return false
    if (cfg.userRefreshToken.trim() === '') return false
    const result = await this.refreshToken()
    return result.ok
  }

  /** Raw token request to authen/v2/oauth/token (JSON body, no auth header). */
  private async exchange(body: Record<string, string>): Promise<FeishuTokenResult> {
    const cfg = await this.store.load()
    const response = await fetch(this.tokenUrl(cfg), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
    const data: unknown = await response.json().catch(() => ({}))
    const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
    const code = typeof record.code === 'number' ? record.code : -1
    if (code !== 0 || !response.ok || typeof record.access_token !== 'string' || record.access_token === '') {
      throw new Error('飞书 OAuth 令牌接口返回错误：' + tokenErrorText(record))
    }
    return {
      access_token: String(record.access_token),
      refresh_token: typeof record.refresh_token === 'string' ? record.refresh_token : '',
      expires_in: typeof record.expires_in === 'number' ? record.expires_in : 0,
      refresh_token_expires_in: typeof record.refresh_token_expires_in === 'number' ? record.refresh_token_expires_in : 0,
      token_type: typeof record.token_type === 'string' ? record.token_type : 'Bearer',
      scope: typeof record.scope === 'string' ? record.scope : '',
    }
  }
}
