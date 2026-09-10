/**
 * dsh-feishu — loopback HTTP routes for the web settings panel.
 *
 * Route family: /api/dsh-feishu/*. All routes are loopback-only
 * (127.0.0.1/localhost, same-origin) — the settings panel is the only
 * consumer.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FeishuStore } from './store.ts'
import type { McpSupervisor } from './mcp.ts'
import type { FeishuOAuthFlow } from './oauth.ts'

/** Route paths. */
export const FEISHU_API = {
  config: '/api/dsh-feishu/config',
  status: '/api/dsh-feishu/status',
  test: '/api/dsh-feishu/test',
  tools: '/api/dsh-feishu/tools',
  oauthStart: '/api/dsh-feishu/oauth/start',
  oauthCallback: '/api/dsh-feishu/oauth/callback',
  oauthFinish: '/api/dsh-feishu/oauth/finish',
  oauthRefresh: '/api/dsh-feishu/oauth/refresh',
} as const

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 256 * 1024

/** Strict loopback fence for all routes. */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Route handler context. */
export interface RouteContext {
  store: FeishuStore
  supervisor: McpSupervisor
  /** OAuth flow (authorize/complete/refresh). */
  oauth: FeishuOAuthFlow
  /** The loopback OAuth callback URL (registered in the Feishu app). */
  callbackUrl: string
}

/** Tiny success/error HTML page for the loopback OAuth callback. */
function oauthCallbackPage(title: string, body: string): string {
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + title + '</title>' +
    '<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;' +
    'min-height:90vh;margin:0;background:#f6f7f9;color:#1f2328}.card{background:#fff;border:1px solid #e2e5e9;' +
    'border-radius:12px;padding:32px 40px;max-width:520px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:18px;' +
    'margin:0 0 12px}p{font-size:14px;line-height:1.7;margin:0}</style></head>' +
    '<body><div class="card"><h1>' + title + '</h1><p>' + body + '</p></div></body></html>'
  )
}

/** Build every /api/dsh-feishu route (exact paths). */
export function makeRoutes(deps: RouteContext) {
  const { store, supervisor, oauth, callbackUrl } = deps

  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  return [
    {
      kind: 'exact' as const,
      path: FEISHU_API.config,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          if (!guard(req, res, 'GET')) return
          writeJson(res, 200, await store.view())
          return
        }
        if (method === 'POST') {
          if (!guard(req, res, 'POST')) return
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          if (body.reset === true) {
            await store.clearAll()
            writeJson(res, 200, await store.view())
            return
          }
          writeJson(res, 200, await store.patch(body))
          return
        }
        writeJson(res, 405, { error: `method not allowed: ${method}` })
      },
    },
    {
      kind: 'exact' as const,
      path: FEISHU_API.status,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const view = await store.view()
        writeJson(res, 200, {
          ...view,
          connected: supervisor.isConnected(),
          toolCount: supervisor.toolCount(),
        })
      },
    },
    {
      kind: 'exact' as const,
      path: FEISHU_API.test,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const connected = supervisor.isConnected()
          const tools = connected ? await supervisor.listTools() : []
          writeJson(res, 200, {
            ok: connected,
            message: connected
              ? `已连接 Feishu MCP，发现 ${tools.length} 个工具。`
              : 'Feishu MCP 未连接（请先配置 App ID / App Secret）。',
            connected,
            toolCount: tools.length,
            tools,
          })
        } catch (error) {
          writeJson(res, 200, {
            ok: false,
            message: '测试失败: ' + String(error instanceof Error ? error.message : error),
            connected: false,
            toolCount: 0,
            tools: [],
          })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: FEISHU_API.tools,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          const tools = supervisor.isConnected() ? await supervisor.listTools() : []
          writeJson(res, 200, { tools })
        } catch (error) {
          writeJson(res, 200, {
            tools: [],
            error: String(error instanceof Error ? error.message : error),
          })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: FEISHU_API.oauthStart,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const { authorizeUrl, state } = await oauth.begin(callbackUrl)
          writeJson(res, 200, { ok: true, authorizeUrl, state, callbackUrl })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: String(error instanceof Error ? error.message : error) })
        }
      },
    },
    {
      kind: 'exact' as const,
      // The OAuth callback is the browser redirecting back from Feishu's
      // authorize page — a cross-site navigation, so it must NOT be
      // loopback/same-origin guarded (it would otherwise be rejected).
      path: FEISHU_API.oauthCallback,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const code = url.searchParams.get('code') ?? ''
        const state = url.searchParams.get('state') ?? ''
        const error = url.searchParams.get('error')
        if (error !== null) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' })
          res.end(oauthCallbackPage('授权失败', '飞书返回错误：' + error + '。可关闭此页面后重试。'))
          return
        }
        const result = code !== '' ? await oauth.complete(code, state) : { ok: false, message: '回调中没有 code 参数。' }
        if (result.ok) await supervisor.restart().catch(() => {})
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' })
        res.end(result.ok
          ? oauthCallbackPage('授权成功', '飞书 MCP 授权已完成，user_access_token 已保存。现在可以关闭此页面，回到 DSH。')
          : oauthCallbackPage('授权失败', result.message))
      },
    },
    {
      kind: 'exact' as const,
      path: FEISHU_API.oauthFinish,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const code = typeof body?.code === 'string' ? body.code : ''
        const state = typeof body?.state === 'string' ? body.state : ''
        if (code.trim() === '') {
          writeJson(res, 200, { ok: false, message: '缺少 code：请把飞书回调地址里的 code 参数交给本接口。' })
          return
        }
        const result = await oauth.complete(code.trim(), state.trim())
        if (result.ok) await supervisor.restart().catch(() => {})
        writeJson(res, 200, { ok: result.ok, message: result.message })
      },
    },
    {
      kind: 'exact' as const,
      path: FEISHU_API.oauthRefresh,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const result = await oauth.refreshToken()
        if (result.ok) await supervisor.restart().catch(() => {})
        writeJson(res, 200, { ok: result.ok, message: result.message })
      },
    },
  ]
}
