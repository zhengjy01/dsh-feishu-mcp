/**
 * dsh-feishu — credential store.
 *
 * Persists the Feishu (Lark) app credentials (App ID + App Secret, and an
 * optional user_access_token from the `login` flow of the official lark-mcp)
 * to ~/.dsh/dsh-feishu.json (mode 0600). Secrets never leave this module;
 * the public view() masks everything. The config path can be overridden
 * with DSH_FEISHU_CONFIG (used by tests).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Default machine-wide config location (mode 0600). */
export const DEFAULT_CONFIG_FILE = path.join(homedir(), '.dsh', 'dsh-feishu.json')

/** Test override for the config location. */
export function configPath(): string {
  const override = process.env.DSH_FEISHU_CONFIG
  return override !== undefined && override !== '' ? override : DEFAULT_CONFIG_FILE
}

/**
 * Persisted shape. `appId`/`appSecret` are the Feishu self-built app
 * credentials; `userAccessToken`/`userRefreshToken` are optional and come
 * from the lark-mcp `login` flow (user identity, e.g. reading private docs
 * or sending IM as the user). Secrets never leave this module.
 */
export interface FeishuCredentials {
  appId: string
  appSecret: string
  userAccessToken: string
  userRefreshToken: string
  /** Epoch ms when the user_access_token expires (0 = unknown / manual paste). */
  userTokenExpiresAt: number
  /** Epoch ms when the refresh_token expires (0 = unknown). */
  userRefreshExpiresAt: number
  /** Granted OAuth scopes (space-separated), e.g. 'offline_access im:message'. */
  scope: string
  /** Feishu API domain (default https://open.feishu.cn; intl https://open.larksuite.com). */
  domain: string
  /** Extra CLI args passed to lark-mcp (e.g. -t presets). */
  extraArgs: string[]
  /** ISO timestamp of the last successful connect / token update. */
  tokenUpdatedAt: string
}

/** Public, secret-free status view. */
export interface FeishuConfigView {
  configured: boolean
  appIdMasked: string
  hasAppSecret: boolean
  hasUserToken: boolean
  /** Epoch ms when the user_access_token expires (0 = unknown). */
  userTokenExpiresAt: number
  /** Epoch ms when the refresh_token expires (0 = unknown). */
  userRefreshExpiresAt: number
  /** Granted OAuth scopes (space-separated). */
  scope: string
  /** Feishu API domain (default https://open.feishu.cn). */
  domain: string
  tokenUpdatedAt: string
  configPath: string
}

/** Mask a credential for display, keeping only the head and tail. */
export function mask(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return value.slice(0, 2) + '****'
  return value.slice(0, 4) + '****' + value.slice(-4)
}

/** Empty credentials record. */
function empty(): FeishuCredentials {
  return {
    appId: '',
    appSecret: '',
    userAccessToken: '',
    userRefreshToken: '',
    userTokenExpiresAt: 0,
    userRefreshExpiresAt: 0,
    scope: '',
    domain: '',
    tokenUpdatedAt: '',
    extraArgs: [],
  }
}

/** Parse an unknown JSON record into credentials (tolerates missing keys). */
function parse(raw: unknown): FeishuCredentials {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    appId: str(record.appId),
    appSecret: str(record.appSecret),
    userAccessToken: str(record.userAccessToken),
    userRefreshToken: str(record.userRefreshToken),
    userTokenExpiresAt: num(record.userTokenExpiresAt),
    userRefreshExpiresAt: num(record.userRefreshExpiresAt),
    scope: str(record.scope),
    domain: str(record.domain),
    tokenUpdatedAt: str(record.tokenUpdatedAt),
    extraArgs: Array.isArray(record.extraArgs)
      ? record.extraArgs.filter((a): a is string => typeof a === 'string')
      : [],
  }
}

/**
 * Small credential store backed by ~/.dsh/dsh-feishu.json.
 * Reads are lazy and cached; writes use mode 0600 so secrets never leak
 * to other local users.
 */
export class FeishuStore {
  config: FeishuCredentials | null = null

  async load(): Promise<FeishuCredentials> {
    if (this.config !== null) return this.config
    try {
      const raw = await readFile(configPath(), 'utf8')
      this.config = parse(JSON.parse(raw))
    } catch {
      // Missing or unreadable config file: treat as unconfigured.
      this.config = empty()
    }
    return this.config
  }

  async save(next: FeishuCredentials): Promise<void> {
    this.config = next
    await mkdir(path.dirname(configPath()), { recursive: true })
    await writeFile(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 })
  }

  /** Public, secret-free view. */
  async view(): Promise<FeishuConfigView> {
    const cfg = await this.load()
    return {
      configured: cfg.appId.trim() !== '' && cfg.appSecret.trim() !== '',
      appIdMasked: mask(cfg.appId),
      hasAppSecret: cfg.appSecret.trim() !== '',
      hasUserToken: cfg.userAccessToken.trim() !== '',
      userTokenExpiresAt: cfg.userTokenExpiresAt,
      userRefreshExpiresAt: cfg.userRefreshExpiresAt,
      scope: cfg.scope,
      domain: cfg.domain || '',
      tokenUpdatedAt: cfg.tokenUpdatedAt,
      configPath: configPath(),
    }
  }

  /** Apply a credentials patch: strings replace, undefined keeps. */
  async patch(args: Record<string, unknown> | undefined): Promise<FeishuConfigView> {
    const cfg = await this.load()
    const next: FeishuCredentials = { ...cfg }
    if (args !== undefined && typeof args.appId === 'string') next.appId = args.appId.trim()
    if (args !== undefined && typeof args.appSecret === 'string') next.appSecret = args.appSecret.trim()
    if (args !== undefined && typeof args.userAccessToken === 'string') {
      next.userAccessToken = args.userAccessToken.trim()
      // Manually pasted tokens carry no expiry; clear it so we never refresh blindly.
      if (args.userAccessToken.trim() !== '') next.userTokenExpiresAt = 0
    }
    if (args !== undefined && typeof args.userRefreshToken === 'string') next.userRefreshToken = args.userRefreshToken.trim()
    if (args !== undefined && typeof args.scope === 'string') next.scope = args.scope.trim()
    if (args !== undefined && typeof args.domain === 'string') next.domain = args.domain.trim()
    if (args !== undefined && Array.isArray(args.extraArgs)) {
      next.extraArgs = args.extraArgs.filter((a): a is string => typeof a === 'string')
    }
    await this.save(next)
    return this.view()
  }

  /** Persist tokens returned by the OAuth flow (user_access_token + refresh). */
  async saveUserTokens(token: { access_token: string; refresh_token: string; expires_in: number; refresh_token_expires_in: number; token_type: string; scope: string }): Promise<void> {
    const cfg = await this.load()
    const now = Date.now()
    await this.save({
      ...cfg,
      userAccessToken: token.access_token,
      userRefreshToken: token.refresh_token,
      userTokenExpiresAt: token.expires_in > 0 ? now + token.expires_in * 1000 : 0,
      userRefreshExpiresAt: token.refresh_token_expires_in > 0 ? now + token.refresh_token_expires_in * 1000 : 0,
      scope: token.scope || cfg.scope,
      tokenUpdatedAt: new Date().toISOString(),
    })
  }

  /** Record a successful connection time. */
  async recordConnected(): Promise<void> {
    const cfg = await this.load()
    await this.save({ ...cfg, tokenUpdatedAt: new Date().toISOString() })
  }

  /** Clear every credential. */
  async clearAll(): Promise<void> {
    await this.save(empty())
  }
}
