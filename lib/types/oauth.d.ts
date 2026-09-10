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
import type { FeishuStore } from './store.ts';
/** Default Feishu (China) API domain. */
export declare const DEFAULT_DOMAIN = "https://open.feishu.cn";
/** Lark (international) API domain. */
export declare const LARK_DOMAIN = "https://open.larksuite.com";
/** How long a pending authorization flow stays valid (ms). */
export declare const PENDING_FLOW_TTL_MS: number;
/** Refresh the user_access_token this far before expiry (ms). */
export declare const REFRESH_SKEW_MS: number;
/** One in-flight authorization flow (single-slot; concurrency rejected). */
export interface PendingFlow {
    state: string;
    /** The redirect_uri used in the authorize request (needed for the exchange). */
    redirectUri: string;
    /** Timestamp of begin(), for TTL eviction. */
    startedAt: number;
}
/** Tokens returned by authen/v2/oauth/token. */
export interface FeishuTokenResult {
    access_token: string;
    refresh_token: string;
    /** user_access_token lifetime in seconds. */
    expires_in: number;
    /** refresh_token lifetime in seconds. */
    refresh_token_expires_in: number;
    token_type: string;
    scope: string;
}
/**
 * Feishu-native OAuth orchestration shared by the routes, the agent tools,
 * and the supervisor's token refresh. `begin` builds the authorize URL;
 * `complete` exchanges the code; `refresh`/`ensureFresh` keeps the token
 * current.
 */
export declare class FeishuOAuthFlow {
    private readonly store;
    private pending;
    constructor(store: FeishuStore);
    /** Whether an authorization flow is currently pending (and not stale). */
    get pendingFlow(): PendingFlow | null;
    /** Abort any pending flow (used by clear/reset). */
    abort(): void;
    /** Short token endpoint for the configured domain. */
    private tokenUrl;
    /** Short authorize URL host for the configured domain. */
    private authorizeUrl;
    /**
     * Start an authorization: validate the app credentials, generate a CSRF
     * `state`, and build the Feishu authorize URL for the browser.
     */
    begin(callbackUrl: string, scopeOverride?: string): Promise<{
        authorizeUrl: string;
        state: string;
    }>;
    /**
     * Complete the flow with the authorization code (auto callback or a paste).
     * Verifies `state` (empty `state` accepts the single pending flow),
     * exchanges the code for tokens, and persists them.
     */
    complete(code: string, state: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    /** Force a refresh of the user_access_token (verifies the refresh flow). */
    refreshToken(): Promise<{
        ok: boolean;
        message: string;
    }>;
    /**
     * Refresh the user_access_token if it is missing, expired, or within
     * REFRESH_SKEW_MS of expiry (and a refresh_token exists). Returns true
     * when a refresh happened — the supervisor reconnects so the spawned
     * lark-mcp picks up the new token via the USER_ACCESS_TOKEN env var.
     */
    ensureFresh(): Promise<boolean>;
    /** Raw token request to authen/v2/oauth/token (JSON body, no auth header). */
    private exchange;
}
