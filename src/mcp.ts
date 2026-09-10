/**
 * dsh-feishu — MCP connection supervisor (stdio transport).
 *
 * Drives the official Feishu OpenAPI MCP server (`@larksuiteoapi/lark-mcp`)
 * as a stdio subprocess: `npx -y @larksuiteoapi/lark-mcp mcp -a <app_id>
 * -s <app_secret>` (plus optional `--token-mode user_access_token` /
 * `-t` tool presets). Discovers the server's tools and registers them on
 * `ctx.tools` under deterministic server-qualified public names
 * (`mcp__feishu__<rawName>`, same contract as @deepseek-ai/dsh-mcp-client).
 *
 * Lifecycle: only starts when app credentials exist. On process exit it
 * restarts with bounded backoff; when the user clears credentials
 * mid-run the supervisor stops.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Context } from '@deepseek-ai/cordis'
import type { FeishuStore } from './store.ts'
import { extendedPath } from './child-env.ts'
import type { FeishuOAuthFlow } from './oauth.ts'

/** Raw call result record: the bridge owns JSON-value validation after transport. */
const RawCallToolResultSchema = z.record(z.string(), z.unknown())

/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
/**
 * Characters that normalize losslessly to `_` (Feishu tool names are
 * dot-separated like `im.v1.message.create`); no hash suffix needed when
 * the name only contains these.
 */
const SAFE_NORMALIZE = /^[A-Za-z0-9_.\-/]+$/
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12
/** Default per-tool-call timeout (ms). */
const TOOL_CALL_TIMEOUT_MS = 60_000
/** Close-signal wait before giving up on a generation (ms). */
const GENERATION_CLOSE_TIMEOUT_MS = 5_000
/** Command used to launch the official lark-mcp server. */
const LARK_MCP_COMMAND = 'npx'
/** npm package of the official Feishu OpenAPI MCP server. */
const LARK_MCP_PACKAGE = '@larksuiteoapi/lark-mcp'

/** Reconnect backoff bounds. */
const RECONNECT = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxAttempts: 10,
} as const

/** Derive the model-facing public name (mcp__feishu__<rawName>). */
export function publicToolName(rawName: string): string {
  const joined = `mcp__feishu__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  // Dot/slash/hyphen names (the Feishu norm, e.g. im.v1.message.create)
  // normalize losslessly to a readable name; only names with unexpected
  // characters fall back to a hashed identity suffix.
  if (SAFE_NORMALIZE.test(rawName) && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`feishu\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Extract readable text from an MCP content array. */
function extractText(mcpContent: unknown, toolName: string): string {
  if (!Array.isArray(mcpContent)) return `(${toolName} returned non-content output)`
  const parts: string[] = []
  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    const block = value as Record<string, unknown>
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'image':
        parts.push(`[image: ${typeof block.mimeType === 'string' ? block.mimeType : 'unknown'}, content discarded]`)
        break
      case 'audio':
        parts.push(`[audio: ${typeof block.mimeType === 'string' ? block.mimeType : 'unknown'}, content discarded]`)
        break
      case 'resource':
      case 'resource_link':
        parts.push('[resource: content discarded]')
        break
      default:
        parts.push(`[unsupported content type: ${String(block.type)}]`)
    }
  }
  return parts.join('\n') || `(${toolName} returned no text content)`
}

/** Connection supervisor handle. */
export interface McpSupervisor {
  /** Start (or restart) the supervised connection. Only connects when credentials exist. */
  start(): Promise<void>
  /** Quit the current generation (if any) and reconnect cleanly (e.g. after an OAuth token change). */
  restart(): Promise<void>
  /** Whether a client generation is currently connected. */
  isConnected(): boolean
  /** Number of tools currently registered from this server. */
  toolCount(): number
  /** List the MCP server's tools (live probe; requires a connected client). */
  listTools(): Promise<string[]>
  /** Stop the supervisor and unregister all tools. */
  dispose(): Promise<void>
}

/**
 * Build the stdio server parameters for the official lark-mcp.
 * The user_access_token is handed to the child through the `USER_ACCESS_TOKEN`
 * env var (the official CLI reads it near startup and, when present, forces
 * user-identity calls) — never on the command line (secrets must not leak to
 * `ps`). `LARK_TOKEN_MODE` mirrors `--token-mode` for clarity.
 * @param cfg - credentials (appId/appSecret + optional user token/domain + extra args).
 */
export function buildServerParams(cfg: { appId: string; appSecret: string; userAccessToken: string; domain?: string; extraArgs: string[] }): StdioServerParameters {
  const args = ['-y', LARK_MCP_PACKAGE, 'mcp', '-a', cfg.appId, '-s', cfg.appSecret]
  if (cfg.domain !== undefined && cfg.domain.trim() !== '') {
    args.push('--domain', cfg.domain.trim())
  }
  if (cfg.userAccessToken.trim() !== '') {
    // Prefer user identity when a user token exists; the official CLI reads
    // it from the USER_ACCESS_TOKEN env var (set below).
    args.push('--token-mode', 'user_access_token')
  }
  for (const extra of cfg.extraArgs) args.push(extra)
  const env = { ...process.env } as Record<string, string>
  // A launchd-started DSH has only /usr/bin:/bin, which hides npx.
  env.PATH = extendedPath()
  if (cfg.userAccessToken.trim() !== '') {
    env.USER_ACCESS_TOKEN = cfg.userAccessToken.trim()
    env.LARK_TOKEN_MODE = 'user_access_token'
  }
  return { command: LARK_MCP_COMMAND, args, env }
}

/**
 * Create the supervised stdio connection to the Feishu MCP server.
 * @param ctx - cordis context carrying the tools registry and logger.
 * @param store - credential store (app credentials gate the connection).
 * @param oauth - OAuth flow (refreshes the user_access_token before spawn).
 * @returns the supervisor handle.
 */
export function createSupervisor(
  ctx: Context,
  store: FeishuStore,
  oauth: FeishuOAuthFlow,
): McpSupervisor {
  const label = 'feishu-mcp'
  let client: Client | null = null
  let clientClosed: Promise<void> | null = null
  let transport: StdioClientTransport | null = null
  let disposers = new Map<string, () => void>()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null
  let failedAttempts = 0
  let connectedAt: number | null = null
  let disposed = false
  /** Serializes every tool sync (initial and notification re-syncs). */
  let syncChain: Promise<unknown> = Promise.resolve()

  const isCurrent = (generation: Client): boolean => !disposed && client === generation

  /** Check token expiry periodically; refresh + reconnect the child when close. */
  function scheduleWatchdog(): void {
    if (disposed) return
    if (watchdogTimer !== null) clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null
      if (disposed) return
      void (async () => {
        try {
          const cfg = await store.load()
          // Only watch when a user token exists and is nearing expiry.
          if (cfg.userAccessToken.trim() === '' || cfg.userTokenExpiresAt <= 0) return
          const nearExpiry = cfg.userTokenExpiresAt - Date.now() <= 5 * 60_000
          if (nearExpiry && cfg.userRefreshToken.trim() !== '') {
            const refreshed = await oauth.ensureFresh().catch(() => false)
            if (refreshed) {
              ctx.logger.info(`${label}: user_access_token refreshed; reconnecting lark-mcp child`)
              void restart()
              return
            }
          }
          scheduleWatchdog()
        } catch {
          scheduleWatchdog()
        }
      })()
    }, 60_000)
    watchdogTimer.unref()
  }

  function enqueueSync(generation: Client): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(generation)) return
      disposers = await syncTools(generation)
    })
    syncChain = run.catch(() => {})
    return run
  }

  function syncTools(generation: Client): Promise<Map<string, () => void>> {
    return listToolsAll(generation).then((tools) => {
      const definitions = tools.map((tool) => ({
        name: publicToolName(tool.name),
        description: tool.description ?? '',
        parameters: tool.inputSchema,
        output: {
          schema: {
            type: 'object' as const,
            properties: {
              content: { type: 'array' as const, items: {} },
              structuredContent: {},
            },
            required: ['content'],
            additionalProperties: false,
          },
          render(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
            const content = typeof value === 'object' && value !== null
              ? (value as Record<string, unknown>).content
              : undefined
            return [{ type: 'text', text: extractText(content, tool.name) }]
          },
        },
        execute: async (args: unknown, exec: { signal: AbortSignal }): Promise<unknown> => {
          const cleanArgs = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
          const result = await callToolUncached(generation, tool.name, cleanArgs, exec.signal)
          if (!Array.isArray(result.content)) {
            const text = 'toolResult' in result ? JSON.stringify(result.toolResult) : '(no output)'
            if (result.isError === true) throw new Error(text)
            return { content: [{ type: 'text', text }] }
          }
          if (result.isError === true) throw new Error(extractText(result.content, tool.name))
          return { content: result.content }
        },
      }))
      for (const dispose of disposers.values()) dispose()
      const next = new Map<string, () => void>()
      for (const definition of definitions) {
        next.set(definition.name, ctx.tools.register(definition))
      }
      return next
    })
  }

  async function listToolsAll(generation: Client): Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>> {
    const tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = []
    let cursor: string | undefined
    do {
      const response = await generation.request({ method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) }, ListToolsResultSchema)
      for (const tool of response.tools) {
        tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown> })
      }
      cursor = response.nextCursor
    } while (cursor !== undefined)
    return tools
  }

  async function callToolUncached(
    generation: Client,
    rawName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ content?: unknown; isError?: boolean; toolResult?: unknown }> {
    const result = await generation.request(
      { method: 'tools/call', params: { name: rawName, arguments: args } },
      RawCallToolResultSchema,
      { signal, timeout: TOOL_CALL_TIMEOUT_MS },
    )
    return result as { content?: unknown; isError?: boolean; toolResult?: unknown }
  }

  function generationDown(generation: Client): void {
    if (!isCurrent(generation)) return
    client = null
    clientClosed = null
    transport = null
    scheduleReconnect()
  }

  function waitForClose(closed: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), GENERATION_CLOSE_TIMEOUT_MS)
      timeout.unref()
      closed.then(() => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }

  function scheduleReconnect(): void {
    if (disposed) return
    if (failedAttempts >= RECONNECT.maxAttempts) {
      syncChain = syncChain.then(() => {
        for (const dispose of disposers.values()) dispose()
        disposers = new Map()
      })
      ctx.logger.error(`${label}: giving up after ${RECONNECT.maxAttempts} reconnect attempts — tools unregistered; re-configure credentials or restart to reconnect`)
      return
    }
    const delayMs = Math.min(RECONNECT.maxDelayMs, RECONNECT.initialDelayMs * 2 ** failedAttempts)
    failedAttempts += 1
    ctx.logger.warn(`${label}: server exited; retrying in ${delayMs}ms (attempt ${failedAttempts}/${RECONNECT.maxAttempts})`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connectGeneration(false)
    }, delayMs)
    reconnectTimer.unref()
  }

  async function connectGeneration(startup: boolean): Promise<void> {
    if (disposed) return
    let cfg = await store.load()
    if (cfg.appId.trim() === '' || cfg.appSecret.trim() === '') {
      ctx.logger.info(`${label}: no Feishu app credentials — connection deferred until configured`)
      return
    }
    // Refresh the user token if near expiry before spawning the child, so the
    // USER_ACCESS_TOKEN env var handed to lark-mcp is current.
    if (cfg.userAccessToken.trim() !== '') {
      const refreshed = await oauth.ensureFresh().catch(() => false)
      if (refreshed) cfg = await store.load()
    }
    const generation = new Client({ name: 'dsh-feishu', version: '0.1.0' }, { capabilities: {} })
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    let attemptSettled = false
    let closeObserved = false
    client = generation
    clientClosed = closed
    generation.onclose = () => {
      closeObserved = true
      resolveClosed()
      if (attemptSettled) generationDown(generation)
    }
    generation.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (!isCurrent(generation)) return
      ctx.logger.info(`${label}: tool list changed, re-syncing`)
      try {
        await enqueueSync(generation)
      } catch (error) {
        if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`)
      }
    })
    try {
      const params = buildServerParams(cfg)
      transport = new StdioClientTransport(params)
      await generation.connect(transport)
      if (closeObserved) {
        attemptSettled = true
        generationDown(generation)
        return
      }
      await enqueueSync(generation)
    } catch (error) {
      if (isCurrent(generation)) ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}`)
      try {
        await generation.close()
      } catch {}
      const quiesced = closeObserved || await waitForClose(closed)
      attemptSettled = true
      if (!isCurrent(generation)) return
      if (!quiesced) {
        client = null
        clientClosed = null
        ctx.logger.error(`${label}: failed generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms — reconnect stopped; restart the Host to retry`)
        return
      }
      generationDown(generation)
      return
    }
    attemptSettled = true
    if (closeObserved) {
      generationDown(generation)
      return
    }
    if (!isCurrent(generation)) return
    connectedAt = Date.now()
    await store.recordConnected()
    scheduleWatchdog()
    if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${RECONNECT.maxAttempts})`)
  }

  /** Quit the current generation (if any) and reconnect, e.g. after OAuth token change. */
  async function restart(): Promise<void> {
    if (disposed) return
    failedAttempts = 0
    const old = client
    if (old !== null) {
      // Detach before closing so the old generation's onclose does not
      // schedule another reconnect (isCurrent(old) is now false).
      client = null
      clientClosed = null
      transport = null
      try {
        await old.close()
      } catch {}
    }
    await connectGeneration(false)
  }

  return {
    async start(): Promise<void> {
      failedAttempts = 0
      await connectGeneration(true)
    },
    restart() {
      return restart()
    },
    isConnected(): boolean {
      return client !== null
    },
    toolCount(): number {
      return disposers.size
    },
    async listTools(): Promise<string[]> {
      if (client === null) throw new Error('Feishu MCP 未连接。')
      const tools = await listToolsAll(client)
      return tools.map((tool) => tool.name)
    },
    async dispose(): Promise<void> {
      disposed = true
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (watchdogTimer !== null) {
        clearTimeout(watchdogTimer)
        watchdogTimer = null
      }
      const current = client
      const currentClosed = clientClosed
      client = null
      clientClosed = null
      if (current !== null) {
        try {
          await current.close()
        } catch {}
        if (currentClosed !== null && !await waitForClose(currentClosed)) {
          ctx.logger.error(`${label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during disposal`)
        }
      }
      await syncChain
      for (const dispose of disposers.values()) dispose()
      disposers = new Map()
    },
  }
}
