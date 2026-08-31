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

/** Route paths. */
export const FEISHU_API = {
  config: '/api/dsh-feishu/config',
  status: '/api/dsh-feishu/status',
  test: '/api/dsh-feishu/test',
  tools: '/api/dsh-feishu/tools',
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
}

/** Build every /api/dsh-feishu route (exact paths). */
export function makeRoutes(deps: RouteContext) {
  const { store, supervisor } = deps

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
  ]
}
