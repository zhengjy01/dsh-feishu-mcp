/**
 * dsh-feishu — Feishu (Lark) OpenAPI MCP connection for DeepSeek Harness.
 * Host half.
 *
 * Mounts the /api/dsh-feishu route family (settings panel talks to it),
 * a supervised stdio connection to the official @larksuiteoapi/lark-mcp
 * server (tools registered as mcp__feishu__*), the agent tools
 * (feishu_status / feishu_config / feishu_test / feishu_tools), and a
 * system-prompt announcement. Plugin config lives in
 * ~/.dsh/dsh-feishu.json (0600).
 *
 * Reuses the same bridge pattern as dsh-vercel-mcp / dsh-cloudflare-mcp:
 * the official MCP server is spawned as a subprocess, its tools are
 * discovered and registered on ctx.tools under deterministic public names.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { FeishuStore } from './store.ts'
import { createSupervisor, type McpSupervisor } from './mcp.ts'
import { makeRoutes, FEISHU_API } from './routes.ts'

/** Stable cordis plugin name. */
export const name = 'feishu-mcp'

/** Services required before the plugin surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 210

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const FEISHU_GUIDANCE =
  '本机已安装 dsh-feishu 插件（飞书 OpenAPI MCP 连接）：驱动官方 @larksuiteoapi/lark-mcp 服务器，把飞书开放平台 API 封装为 mcp__feishu__* 工具（IM 消息、多维表格 Bitable、云文档、日历、云盘等，具体以连接后发现的工具为准）。' +
  '工具：feishu_status（状态）、feishu_config（配置 App ID / App Secret / 用户令牌）、feishu_test（测试连接并列出工具）、feishu_tools（列出工具）。' +
  '前提：需先在飞书开放平台创建企业自建应用并添加所需权限（im/bitable/docx/calendar/drive 等），把 App ID / App Secret 配置进插件；如需以用户身份访问私有资源，可另行登录用户令牌。' +
  '用户提到「飞书 / Feishu / Lark / 多维表格 / 发飞书消息」时即指本插件，请据此协作。'

/** Plugin config, read from the composition row. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /** Master switch for the plugin (routes, prompt section, supervisor). */
  enabled?: boolean
}

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Shared tool dependencies. */
export interface ToolContext {
  store: FeishuStore
  supervisor: McpSupervisor
}

/** Status tool: config + connection state. */
export function feishuStatusTool(ctx: ToolContext) {
  return defineTool({
    name: 'feishu_status',
    description: '查看 dsh-feishu 插件状态：是否已配置飞书 App ID/Secret、是否已连接 MCP、已注册的飞书工具数量、最近连接时间。不会泄露任何密钥。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          configured: { type: 'boolean' },
          connected: { type: 'boolean' },
          toolCount: { type: 'number' },
          appIdMasked: { type: 'string' },
          hasUserToken: { type: 'boolean' },
          tokenUpdatedAt: { type: 'string' },
          configPath: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      try {
        const view = await ctx.store.view()
        const parts: string[] = [
          '飞书配置：' + (view.configured ? '已配置（App ID ' + view.appIdMasked + '）' : '未配置（请用 feishu_config 设置 App ID / App Secret）'),
          'MCP 连接：' + (ctx.supervisor.isConnected() ? '已连接' : '未连接'),
          '已注册工具：' + ctx.supervisor.toolCount() + ' 个（mcp__feishu__*）',
          '用户令牌：' + (view.hasUserToken ? '已配置' : '未配置（tenant 身份）'),
        ]
        if (view.tokenUpdatedAt) parts.push('最近连接：' + view.tokenUpdatedAt)
        return { ok: true, message: parts.join('\n'), ...view, connected: ctx.supervisor.isConnected(), toolCount: ctx.supervisor.toolCount() }
      } catch (error) {
        return { ok: false, message: '读取状态失败: ' + String(error instanceof Error ? error.message : error) }
      }
    },
  })
}

/** Config tool: update Feishu credentials. */
export function feishuConfigTool(ctx: ToolContext) {
  return defineTool({
    name: 'feishu_config',
    description: '配置 dsh-feishu 飞书凭据：appId/appSecret（飞书开放平台企业自建应用的 App ID / App Secret）、userAccessToken/userRefreshToken（可选，用户身份令牌）、extraArgs（可选，传给 lark-mcp 的额外 CLI 参数，如 -t 工具预设）。配置持久化到 ~/.dsh/dsh-feishu.json（0600）。传 reset: true 清除全部凭据。',
    parameters: {
      appId: { type: 'string', description: '飞书 App ID（开放平台创建应用获取）' },
      appSecret: { type: 'string', description: '飞书 App Secret' },
      userAccessToken: { type: 'string', description: '可选：用户访问令牌（user_access_token，访问私有资源时用）' },
      userRefreshToken: { type: 'string', description: '可选：用户刷新令牌' },
      extraArgs: { type: 'array', items: { type: 'string' }, description: '可选：额外 CLI 参数（如 -t preset）' },
      reset: { type: 'boolean', description: '清除全部凭据' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          configured: { type: 'boolean' },
          appIdMasked: { type: 'string' },
          configPath: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute(args: Record<string, unknown>) {
      try {
        if (args !== undefined && args.reset === true) {
          await ctx.store.clearAll()
          return { ok: true, message: '已清除飞书凭据。', configured: false, appIdMasked: '', configPath: (await ctx.store.view()).configPath }
        }
        const view = await ctx.store.patch(args)
        const msg = view.configured
          ? '飞书凭据已保存（App ID ' + view.appIdMasked + (view.hasUserToken ? '，含用户令牌' : '') + '）。重启或下次连接时生效。'
          : '飞书凭据不完整：需要 App ID 与 App Secret。'
        return { ok: true, message: msg, configured: view.configured, appIdMasked: view.appIdMasked, configPath: view.configPath }
      } catch (error) {
        return { ok: false, message: '配置失败: ' + String(error instanceof Error ? error.message : error) }
      }
    },
  })
}

/** Test tool: probe the MCP connection and list tools. */
export function feishuTestTool(ctx: ToolContext) {
  return defineTool({
    name: 'feishu_test',
    description: '测试 dsh-feishu 飞书 MCP 连接：确认连接有效并列出服务器当前提供的全部工具名（mcp__feishu__* 的前身工具名）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          connected: { type: 'boolean' },
          toolCount: { type: 'number' },
          tools: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      try {
        const connected = ctx.supervisor.isConnected()
        const tools = connected ? await ctx.supervisor.listTools() : []
        return {
          ok: connected,
          message: connected
            ? `已连接飞书 MCP，共 ${tools.length} 个工具：\n${tools.join('\n')}`
            : '飞书 MCP 未连接（请先配置 App ID / App Secret 并等待连接）。',
          connected,
          toolCount: tools.length,
          tools,
        }
      } catch (error) {
        return { ok: false, message: '测试失败: ' + String(error instanceof Error ? error.message : error), connected: false, toolCount: 0, tools: [] }
      }
    },
  })
}

/** Tools tool: list the MCP server's tools. */
export function feishuToolsTool(ctx: ToolContext) {
  return defineTool({
    name: 'feishu_tools',
    description: '列出 dsh-feishu 飞书 MCP 服务器当前提供的全部工具名（mcp__feishu__* 的前身工具名）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          tools: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      try {
        if (!ctx.supervisor.isConnected()) return { ok: false, message: '飞书 MCP 未连接（请先配置 App ID / App Secret）。', tools: [] }
        const tools = await ctx.supervisor.listTools()
        return { ok: true, message: '飞书工具（' + tools.length + ' 个）：\n' + tools.join('\n'), tools }
      } catch (error) {
        return { ok: false, message: '列工具失败: ' + String(error instanceof Error ? error.message : error), tools: [] }
      }
    },
  })
}

/** Build the tool list for registration. */
export function buildTools(ctx: ToolContext) {
  return [feishuStatusTool(ctx), feishuConfigTool(ctx), feishuTestTool(ctx), feishuToolsTool(ctx)]
}

/**
 * Mount the Feishu MCP tools, routes, announcement, and supervised connection.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - plugin config from the composition row.
 */
export function apply(ctx: Context, config?: Config): void {
  const announceToAgent = config?.announceToAgent !== false
  const enabled = config?.enabled !== false
  const store = new FeishuStore()
  const supervisor = createSupervisor(ctx, store)
  const context: ToolContext = { store, supervisor }

  let disposeTools: (() => void) | undefined
  let disposeRoutes: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    if (disposeTools !== undefined) { disposeTools(); disposeTools = undefined }
    if (disposeRoutes !== undefined) { disposeRoutes(); disposeRoutes = undefined }
    if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
    if (!enabled) return
    disposeTools = ctx.effect(
      () => {
        const disposers = buildTools(context).map((tool) => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-feishu: tools',
    )
    disposeRoutes = ctx.effect(
      () => {
        const disposers = makeRoutes(context).map((route) => ctx.webServer.register(route))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-feishu: routes',
    )
    if (announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-feishu',
        order: SECTION_ORDER,
        text: FEISHU_GUIDANCE,
      })
    }
  }

  sync()

  // Auto-connect when credentials already exist (e.g. after a host restart).
  void (async () => {
    if (!enabled) return
    const view = await store.view()
    if (view.configured) {
      void supervisor.start().catch(() => {})
    }
  })()

  ctx.effect(() => {
    return () => { void supervisor.dispose() }
  }, 'dsh-feishu: connection')
}

/** Re-exports for host consumers and the smoke tests. */
export { FeishuStore, configPath, DEFAULT_CONFIG_FILE, mask, type FeishuCredentials, type FeishuConfigView } from './store.ts'
export { createSupervisor, buildServerParams, publicToolName, type McpSupervisor } from './mcp.ts'
export { makeRoutes, FEISHU_API } from './routes.ts'
export { defineTool }
