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
import { type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Context } from '@deepseek-ai/cordis';
import type { FeishuStore } from './store.ts';
import type { FeishuOAuthFlow } from './oauth.ts';
/** Derive the model-facing public name (mcp__feishu__<rawName>). */
export declare function publicToolName(rawName: string): string;
/** Connection supervisor handle. */
export interface McpSupervisor {
    /** Start (or restart) the supervised connection. Only connects when credentials exist. */
    start(): Promise<void>;
    /** Quit the current generation (if any) and reconnect cleanly (e.g. after an OAuth token change). */
    restart(): Promise<void>;
    /** Whether a client generation is currently connected. */
    isConnected(): boolean;
    /** Number of tools currently registered from this server. */
    toolCount(): number;
    /** List the MCP server's tools (live probe; requires a connected client). */
    listTools(): Promise<string[]>;
    /** Stop the supervisor and unregister all tools. */
    dispose(): Promise<void>;
}
/**
 * Build the stdio server parameters for the official lark-mcp.
 * The user_access_token is handed to the child through the `USER_ACCESS_TOKEN`
 * env var (the official CLI reads it near startup and, when present, forces
 * user-identity calls) — never on the command line (secrets must not leak to
 * `ps`). `LARK_TOKEN_MODE` mirrors `--token-mode` for clarity.
 * @param cfg - credentials (appId/appSecret + optional user token/domain + extra args).
 */
export declare function buildServerParams(cfg: {
    appId: string;
    appSecret: string;
    userAccessToken: string;
    domain?: string;
    extraArgs: string[];
}): StdioServerParameters;
/**
 * Create the supervised stdio connection to the Feishu MCP server.
 * @param ctx - cordis context carrying the tools registry and logger.
 * @param store - credential store (app credentials gate the connection).
 * @param oauth - OAuth flow (refreshes the user_access_token before spawn).
 * @returns the supervisor handle.
 */
export declare function createSupervisor(ctx: Context, store: FeishuStore, oauth: FeishuOAuthFlow): McpSupervisor;
