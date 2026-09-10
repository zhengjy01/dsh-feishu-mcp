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
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { FeishuStore } from './store.ts';
import { type McpSupervisor } from './mcp.ts';
import { FeishuOAuthFlow } from './oauth.ts';
/** Stable cordis plugin name. */
export declare const name = "feishu-mcp";
/** Services required before the plugin surfaces can mount. */
export declare const inject: string[];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
export declare const FEISHU_GUIDANCE: string;
/** Plugin config, read from the composition row. */
export interface Config {
    /** When true (default), a system-prompt section announces the plugin. */
    announceToAgent?: boolean;
    /** Master switch for the plugin (routes, prompt section, supervisor). */
    enabled?: boolean;
}
/** Shared tool dependencies. */
export interface ToolContext {
    store: FeishuStore;
    supervisor: McpSupervisor;
    /** OAuth flow (authorize/complete/refresh). */
    oauth: FeishuOAuthFlow;
    /** The loopback OAuth callback URL. */
    callbackUrl: string;
}
/** Status tool: config + connection state. */
export declare function feishuStatusTool(ctx: ToolContext): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Config tool: update Feishu credentials. */
export declare function feishuConfigTool(ctx: ToolContext): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Test tool: probe the MCP connection and list tools. */
export declare function feishuTestTool(ctx: ToolContext): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Tools tool: list the MCP server's tools. */
export declare function feishuToolsTool(ctx: ToolContext): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** OAuth start tool: build the Feishu authorize URL for the browser. */
export declare function feishuOauthStartTool(ctx: ToolContext): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** OAuth finish tool: exchange a callback code (manual paste path). */
export declare function feishuOauthFinishTool(ctx: ToolContext): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** OAuth refresh tool: refresh the user_access_token. */
export declare function feishuOauthRefreshTool(ctx: ToolContext): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build the tool list for registration. */
export declare function buildTools(ctx: ToolContext): import("@deepseek-ai/dsh-tools").ToolDefinition[];
/**
 * Mount the Feishu MCP tools, routes, announcement, and supervised connection.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - plugin config from the composition row.
 */
export declare function apply(ctx: Context, config?: Config): void;
/** Re-exports for host consumers and the smoke tests. */
export { FeishuStore, configPath, DEFAULT_CONFIG_FILE, mask, type FeishuCredentials, type FeishuConfigView } from './store.ts';
export { createSupervisor, buildServerParams, publicToolName, type McpSupervisor } from './mcp.ts';
export { makeRoutes, FEISHU_API } from './routes.ts';
export { FeishuOAuthFlow, DEFAULT_DOMAIN, LARK_DOMAIN, type FeishuTokenResult } from './oauth.ts';
export { defineTool };
