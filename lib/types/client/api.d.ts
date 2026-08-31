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
    tokenUpdatedAt: string;
    configPath: string;
    connected: boolean;
    toolCount: number;
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
}
