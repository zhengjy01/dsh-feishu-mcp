/**
 * dsh-feishu — credential store.
 *
 * Persists the Feishu (Lark) app credentials (App ID + App Secret, and an
 * optional user_access_token from the `login` flow of the official lark-mcp)
 * to ~/.dsh/dsh-feishu.json (mode 0600). Secrets never leave this module;
 * the public view() masks everything. The config path can be overridden
 * with DSH_FEISHU_CONFIG (used by tests).
 */
/** Default machine-wide config location (mode 0600). */
export declare const DEFAULT_CONFIG_FILE: string;
/** Test override for the config location. */
export declare function configPath(): string;
/**
 * Persisted shape. `appId`/`appSecret` are the Feishu self-built app
 * credentials; `userAccessToken`/`userRefreshToken` are optional and come
 * from the lark-mcp `login` flow (user identity, e.g. reading private docs
 * or sending IM as the user). Secrets never leave this module.
 */
export interface FeishuCredentials {
    appId: string;
    appSecret: string;
    userAccessToken: string;
    userRefreshToken: string;
    /** Epoch ms when the user_access_token expires (0 = unknown / manual paste). */
    userTokenExpiresAt: number;
    /** Epoch ms when the refresh_token expires (0 = unknown). */
    userRefreshExpiresAt: number;
    /** Granted OAuth scopes (space-separated), e.g. 'offline_access im:message'. */
    scope: string;
    /** Feishu API domain (default https://open.feishu.cn; intl https://open.larksuite.com). */
    domain: string;
    /** Extra CLI args passed to lark-mcp (e.g. -t presets). */
    extraArgs: string[];
    /** ISO timestamp of the last successful connect / token update. */
    tokenUpdatedAt: string;
}
/** Public, secret-free status view. */
export interface FeishuConfigView {
    configured: boolean;
    appIdMasked: string;
    hasAppSecret: boolean;
    hasUserToken: boolean;
    /** Epoch ms when the user_access_token expires (0 = unknown). */
    userTokenExpiresAt: number;
    /** Epoch ms when the refresh_token expires (0 = unknown). */
    userRefreshExpiresAt: number;
    /** Granted OAuth scopes (space-separated). */
    scope: string;
    /** Feishu API domain (default https://open.feishu.cn). */
    domain: string;
    tokenUpdatedAt: string;
    configPath: string;
}
/** Mask a credential for display, keeping only the head and tail. */
export declare function mask(value: string): string;
/**
 * Small credential store backed by ~/.dsh/dsh-feishu.json.
 * Reads are lazy and cached; writes use mode 0600 so secrets never leak
 * to other local users.
 */
export declare class FeishuStore {
    config: FeishuCredentials | null;
    load(): Promise<FeishuCredentials>;
    save(next: FeishuCredentials): Promise<void>;
    /** Public, secret-free view. */
    view(): Promise<FeishuConfigView>;
    /** Apply a credentials patch: strings replace, undefined keeps. */
    patch(args: Record<string, unknown> | undefined): Promise<FeishuConfigView>;
    /** Persist tokens returned by the OAuth flow (user_access_token + refresh). */
    saveUserTokens(token: {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        refresh_token_expires_in: number;
        token_type: string;
        scope: string;
    }): Promise<void>;
    /** Record a successful connection time. */
    recordConnected(): Promise<void>;
    /** Clear every credential. */
    clearAll(): Promise<void>;
}
