/**
 * dsh-feishu — loopback HTTP routes for the web settings panel.
 *
 * Route family: /api/dsh-feishu/*. All routes are loopback-only
 * (127.0.0.1/localhost, same-origin) — the settings panel is the only
 * consumer.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FeishuStore } from './store.ts';
import type { McpSupervisor } from './mcp.ts';
/** Route paths. */
export declare const FEISHU_API: {
    readonly config: "/api/dsh-feishu/config";
    readonly status: "/api/dsh-feishu/status";
    readonly test: "/api/dsh-feishu/test";
    readonly tools: "/api/dsh-feishu/tools";
};
/** Route handler context. */
export interface RouteContext {
    store: FeishuStore;
    supervisor: McpSupervisor;
}
/** Build every /api/dsh-feishu route (exact paths). */
export declare function makeRoutes(deps: RouteContext): ({
    kind: "exact";
    path: "/api/dsh-feishu/config";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-feishu/status";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-feishu/test";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-feishu/tools";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
})[];
