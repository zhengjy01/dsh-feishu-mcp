/**
 * Browser-side API client for the /api/dsh-feishu route family.
 * The only data access path the settings panel uses — plain fetch, same origin.
 */
/** Public config view (mirrors the host contract). */
export interface FeishuConfigView {
    configured: boolean;
    appIdMasked: string;
    hasAppSecret: boolean;
    hasUserToken: boolean;
    userTokenExpiresAt: number;
    userRefreshExpiresAt: number;
    scope: string;
    domain: string;
    tokenUpdatedAt: string;
    configPath: string;
    connected: boolean;
    toolCount: number;
}
/** OAuth start result. */
export interface FeishuOAuthStartResult {
    ok: boolean;
    authorizeUrl?: string;
    state?: string;
    callbackUrl?: string;
    error?: string;
}
/** OAuth finish / refresh result. */
export interface FeishuOAuthActionResult {
    ok: boolean;
    message: string;
}
/** Test result. */
export interface FeishuTestResult {
    ok: boolean;
    message: string;
    connected: boolean;
    toolCount: number;
    tools: string[];
}
/** Error carrying the route's JSON error message. */
export declare class FeishuApiError extends Error {
    constructor(message: string);
}
/** The Feishu panel API. */
export declare class FeishuApi {
    getStatus(): Promise<FeishuConfigView>;
    setConfig(patch: Record<string, unknown>): Promise<FeishuConfigView>;
    reset(): Promise<FeishuConfigView>;
    test(): Promise<FeishuTestResult>;
    oauthStart(): Promise<FeishuOAuthStartResult>;
    oauthFinish(code: string, state?: string): Promise<FeishuOAuthActionResult>;
    oauthRefresh(): Promise<FeishuOAuthActionResult>;
}
