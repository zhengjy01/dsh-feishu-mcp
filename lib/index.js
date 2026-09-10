import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readdirSync } from "node:fs";
//#region src/store.ts
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
const DEFAULT_CONFIG_FILE = path.join(homedir(), ".dsh", "dsh-feishu.json");
/** Test override for the config location. */
function configPath() {
	const override = process.env.DSH_FEISHU_CONFIG;
	return override !== void 0 && override !== "" ? override : DEFAULT_CONFIG_FILE;
}
/** Mask a credential for display, keeping only the head and tail. */
function mask(value) {
	if (!value) return "";
	if (value.length <= 8) return value.slice(0, 2) + "****";
	return value.slice(0, 4) + "****" + value.slice(-4);
}
/** Empty credentials record. */
function empty() {
	return {
		appId: "",
		appSecret: "",
		userAccessToken: "",
		userRefreshToken: "",
		userTokenExpiresAt: 0,
		userRefreshExpiresAt: 0,
		scope: "",
		domain: "",
		tokenUpdatedAt: "",
		extraArgs: []
	};
}
/** Parse an unknown JSON record into credentials (tolerates missing keys). */
function parse(raw) {
	const record = typeof raw === "object" && raw !== null ? raw : {};
	const str = (value) => typeof value === "string" ? value : "";
	const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
	return {
		appId: str(record.appId),
		appSecret: str(record.appSecret),
		userAccessToken: str(record.userAccessToken),
		userRefreshToken: str(record.userRefreshToken),
		userTokenExpiresAt: num(record.userTokenExpiresAt),
		userRefreshExpiresAt: num(record.userRefreshExpiresAt),
		scope: str(record.scope),
		domain: str(record.domain),
		tokenUpdatedAt: str(record.tokenUpdatedAt),
		extraArgs: Array.isArray(record.extraArgs) ? record.extraArgs.filter((a) => typeof a === "string") : []
	};
}
/**
* Small credential store backed by ~/.dsh/dsh-feishu.json.
* Reads are lazy and cached; writes use mode 0600 so secrets never leak
* to other local users.
*/
var FeishuStore = class {
	config = null;
	async load() {
		if (this.config !== null) return this.config;
		try {
			const raw = await readFile(configPath(), "utf8");
			this.config = parse(JSON.parse(raw));
		} catch {
			this.config = empty();
		}
		return this.config;
	}
	async save(next) {
		this.config = next;
		await mkdir(path.dirname(configPath()), { recursive: true });
		await writeFile(configPath(), JSON.stringify(next, null, 2), { mode: 384 });
	}
	/** Public, secret-free view. */
	async view() {
		const cfg = await this.load();
		return {
			configured: cfg.appId.trim() !== "" && cfg.appSecret.trim() !== "",
			appIdMasked: mask(cfg.appId),
			hasAppSecret: cfg.appSecret.trim() !== "",
			hasUserToken: cfg.userAccessToken.trim() !== "",
			userTokenExpiresAt: cfg.userTokenExpiresAt,
			userRefreshExpiresAt: cfg.userRefreshExpiresAt,
			scope: cfg.scope,
			domain: cfg.domain || "",
			tokenUpdatedAt: cfg.tokenUpdatedAt,
			configPath: configPath()
		};
	}
	/** Apply a credentials patch: strings replace, undefined keeps. */
	async patch(args) {
		const next = { ...await this.load() };
		if (args !== void 0 && typeof args.appId === "string") next.appId = args.appId.trim();
		if (args !== void 0 && typeof args.appSecret === "string") next.appSecret = args.appSecret.trim();
		if (args !== void 0 && typeof args.userAccessToken === "string") {
			next.userAccessToken = args.userAccessToken.trim();
			if (args.userAccessToken.trim() !== "") next.userTokenExpiresAt = 0;
		}
		if (args !== void 0 && typeof args.userRefreshToken === "string") next.userRefreshToken = args.userRefreshToken.trim();
		if (args !== void 0 && typeof args.scope === "string") next.scope = args.scope.trim();
		if (args !== void 0 && typeof args.domain === "string") next.domain = args.domain.trim();
		if (args !== void 0 && Array.isArray(args.extraArgs)) next.extraArgs = args.extraArgs.filter((a) => typeof a === "string");
		await this.save(next);
		return this.view();
	}
	/** Persist tokens returned by the OAuth flow (user_access_token + refresh). */
	async saveUserTokens(token) {
		const cfg = await this.load();
		const now = Date.now();
		await this.save({
			...cfg,
			userAccessToken: token.access_token,
			userRefreshToken: token.refresh_token,
			userTokenExpiresAt: token.expires_in > 0 ? now + token.expires_in * 1e3 : 0,
			userRefreshExpiresAt: token.refresh_token_expires_in > 0 ? now + token.refresh_token_expires_in * 1e3 : 0,
			scope: token.scope || cfg.scope,
			tokenUpdatedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
	}
	/** Record a successful connection time. */
	async recordConnected() {
		const cfg = await this.load();
		await this.save({
			...cfg,
			tokenUpdatedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
	}
	/** Clear every credential. */
	async clearAll() {
		await this.save(empty());
	}
};
//#endregion
//#region src/child-env.ts
/**
* dsh-feishu — child-process environment.
*
* The MCP server is spawned as a child process. DSH itself can be
* started by launchd (the shipped `com.dsh.web` service), whose PATH is only
* `/usr/bin:/bin`, so a bare `npx` / `uvx` fails with
* ENOENT even though it is installed. Every spawned server therefore receives
* a PATH that also carries the well-known install directories.
*/
/** Well-known directories that commonly hold a globally installed CLI. */
function extraBinDirs() {
	const home = homedir();
	const dirs = [
		path.join(home, ".local", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		path.join(home, ".bun", "bin"),
		path.join(home, ".volta", "bin"),
		"/usr/bin",
		"/bin"
	];
	for (const manager of [
		".nvm/versions/node",
		".local/share/fnm/node-versions",
		".asdf/installs/nodejs"
	]) {
		const root = path.join(home, manager);
		try {
			for (const entry of readdirSync(root)) dirs.push(path.join(root, entry, "bin"));
		} catch {}
	}
	return dirs;
}
/**
* The inherited PATH with every existing well-known bin directory appended.
* @returns a PATH value safe to hand to a spawned child process.
*/
function extendedPath() {
	const segments = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== "");
	const seen = new Set(segments);
	for (const dir of extraBinDirs()) {
		if (seen.has(dir) || !existsSync(dir)) continue;
		seen.add(dir);
		segments.push(dir);
	}
	return segments.join(path.delimiter);
}
//#endregion
//#region src/mcp.ts
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
/** Raw call result record: the bridge owns JSON-value validation after transport. */
const RawCallToolResultSchema = z.record(z.string(), z.unknown());
/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64;
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
/**
* Characters that normalize losslessly to `_` (Feishu tool names are
* dot-separated like `im.v1.message.create`); no hash suffix needed when
* the name only contains these.
*/
const SAFE_NORMALIZE = /^[A-Za-z0-9_.\-/]+$/;
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12;
/** Default per-tool-call timeout (ms). */
const TOOL_CALL_TIMEOUT_MS = 6e4;
/** Close-signal wait before giving up on a generation (ms). */
const GENERATION_CLOSE_TIMEOUT_MS = 5e3;
/** Command used to launch the official lark-mcp server. */
const LARK_MCP_COMMAND = "npx";
/** npm package of the official Feishu OpenAPI MCP server. */
const LARK_MCP_PACKAGE = "@larksuiteoapi/lark-mcp";
/** Reconnect backoff bounds. */
const RECONNECT = {
	initialDelayMs: 1e3,
	maxDelayMs: 3e4,
	maxAttempts: 10
};
/** Derive the model-facing public name (mcp__feishu__<rawName>). */
function publicToolName(rawName) {
	const normalized = `mcp__feishu__${rawName}`.replace(INVALID_NAME_CHARS, "_");
	if (SAFE_NORMALIZE.test(rawName) && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
	const hash = createHash("sha256").update(`feishu\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
	return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}
/** Extract readable text from an MCP content array. */
function extractText(mcpContent, toolName) {
	if (!Array.isArray(mcpContent)) return `(${toolName} returned non-content output)`;
	const parts = [];
	for (const value of mcpContent) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			parts.push("[unsupported content type: unknown]");
			continue;
		}
		const block = value;
		switch (block.type) {
			case "text":
				if (typeof block.text === "string") parts.push(block.text);
				break;
			case "image":
				parts.push(`[image: ${typeof block.mimeType === "string" ? block.mimeType : "unknown"}, content discarded]`);
				break;
			case "audio":
				parts.push(`[audio: ${typeof block.mimeType === "string" ? block.mimeType : "unknown"}, content discarded]`);
				break;
			case "resource":
			case "resource_link":
				parts.push("[resource: content discarded]");
				break;
			default: parts.push(`[unsupported content type: ${String(block.type)}]`);
		}
	}
	return parts.join("\n") || `(${toolName} returned no text content)`;
}
/**
* Build the stdio server parameters for the official lark-mcp.
* The user_access_token is handed to the child through the `USER_ACCESS_TOKEN`
* env var (the official CLI reads it near startup and, when present, forces
* user-identity calls) — never on the command line (secrets must not leak to
* `ps`). `LARK_TOKEN_MODE` mirrors `--token-mode` for clarity.
* @param cfg - credentials (appId/appSecret + optional user token/domain + extra args).
*/
function buildServerParams(cfg) {
	const args = [
		"-y",
		LARK_MCP_PACKAGE,
		"mcp",
		"-a",
		cfg.appId,
		"-s",
		cfg.appSecret
	];
	if (cfg.domain !== void 0 && cfg.domain.trim() !== "") args.push("--domain", cfg.domain.trim());
	if (cfg.userAccessToken.trim() !== "") args.push("--token-mode", "user_access_token");
	for (const extra of cfg.extraArgs) args.push(extra);
	const env = { ...process.env };
	env.PATH = extendedPath();
	if (cfg.userAccessToken.trim() !== "") {
		env.USER_ACCESS_TOKEN = cfg.userAccessToken.trim();
		env.LARK_TOKEN_MODE = "user_access_token";
	}
	return {
		command: LARK_MCP_COMMAND,
		args,
		env
	};
}
/**
* Create the supervised stdio connection to the Feishu MCP server.
* @param ctx - cordis context carrying the tools registry and logger.
* @param store - credential store (app credentials gate the connection).
* @param oauth - OAuth flow (refreshes the user_access_token before spawn).
* @returns the supervisor handle.
*/
function createSupervisor(ctx, store, oauth) {
	const label = "feishu-mcp";
	let client = null;
	let clientClosed = null;
	let transport = null;
	let disposers = /* @__PURE__ */ new Map();
	let reconnectTimer = null;
	let watchdogTimer = null;
	let failedAttempts = 0;
	let disposed = false;
	/** Serializes every tool sync (initial and notification re-syncs). */
	let syncChain = Promise.resolve();
	const isCurrent = (generation) => !disposed && client === generation;
	/** Check token expiry periodically; refresh + reconnect the child when close. */
	function scheduleWatchdog() {
		if (disposed) return;
		if (watchdogTimer !== null) clearTimeout(watchdogTimer);
		watchdogTimer = setTimeout(() => {
			watchdogTimer = null;
			if (disposed) return;
			(async () => {
				try {
					const cfg = await store.load();
					if (cfg.userAccessToken.trim() === "" || cfg.userTokenExpiresAt <= 0) return;
					if (cfg.userTokenExpiresAt - Date.now() <= 5 * 6e4 && cfg.userRefreshToken.trim() !== "") {
						if (await oauth.ensureFresh().catch(() => false)) {
							ctx.logger.info(`${label}: user_access_token refreshed; reconnecting lark-mcp child`);
							restart();
							return;
						}
					}
					scheduleWatchdog();
				} catch {
					scheduleWatchdog();
				}
			})();
		}, 6e4);
		watchdogTimer.unref();
	}
	function enqueueSync(generation) {
		const run = syncChain.then(async () => {
			if (!isCurrent(generation)) return;
			disposers = await syncTools(generation);
		});
		syncChain = run.catch(() => {});
		return run;
	}
	function syncTools(generation) {
		return listToolsAll(generation).then((tools) => {
			const definitions = tools.map((tool) => ({
				name: publicToolName(tool.name),
				description: tool.description ?? "",
				parameters: tool.inputSchema,
				output: {
					schema: {
						type: "object",
						properties: {
							content: {
								type: "array",
								items: {}
							},
							structuredContent: {}
						},
						required: ["content"],
						additionalProperties: false
					},
					render(_args, value) {
						return [{
							type: "text",
							text: extractText(typeof value === "object" && value !== null ? value.content : void 0, tool.name)
						}];
					}
				},
				execute: async (args, exec) => {
					const cleanArgs = typeof args === "object" && args !== null ? args : {};
					const result = await callToolUncached(generation, tool.name, cleanArgs, exec.signal);
					if (!Array.isArray(result.content)) {
						const text = "toolResult" in result ? JSON.stringify(result.toolResult) : "(no output)";
						if (result.isError === true) throw new Error(text);
						return { content: [{
							type: "text",
							text
						}] };
					}
					if (result.isError === true) throw new Error(extractText(result.content, tool.name));
					return { content: result.content };
				}
			}));
			for (const dispose of disposers.values()) dispose();
			const next = /* @__PURE__ */ new Map();
			for (const definition of definitions) next.set(definition.name, ctx.tools.register(definition));
			return next;
		});
	}
	async function listToolsAll(generation) {
		const tools = [];
		let cursor;
		do {
			const response = await generation.request({
				method: "tools/list",
				...cursor === void 0 ? {} : { params: { cursor } }
			}, ListToolsResultSchema);
			for (const tool of response.tools) tools.push({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema
			});
			cursor = response.nextCursor;
		} while (cursor !== void 0);
		return tools;
	}
	async function callToolUncached(generation, rawName, args, signal) {
		return await generation.request({
			method: "tools/call",
			params: {
				name: rawName,
				arguments: args
			}
		}, RawCallToolResultSchema, {
			signal,
			timeout: TOOL_CALL_TIMEOUT_MS
		});
	}
	function generationDown(generation) {
		if (!isCurrent(generation)) return;
		client = null;
		clientClosed = null;
		transport = null;
		scheduleReconnect();
	}
	function waitForClose(closed) {
		return new Promise((resolve) => {
			const timeout = setTimeout(() => resolve(false), GENERATION_CLOSE_TIMEOUT_MS);
			timeout.unref();
			closed.then(() => {
				clearTimeout(timeout);
				resolve(true);
			});
		});
	}
	function scheduleReconnect() {
		if (disposed) return;
		if (failedAttempts >= RECONNECT.maxAttempts) {
			syncChain = syncChain.then(() => {
				for (const dispose of disposers.values()) dispose();
				disposers = /* @__PURE__ */ new Map();
			});
			ctx.logger.error(`${label}: giving up after ${RECONNECT.maxAttempts} reconnect attempts — tools unregistered; re-configure credentials or restart to reconnect`);
			return;
		}
		const delayMs = Math.min(RECONNECT.maxDelayMs, RECONNECT.initialDelayMs * 2 ** failedAttempts);
		failedAttempts += 1;
		ctx.logger.warn(`${label}: server exited; retrying in ${delayMs}ms (attempt ${failedAttempts}/${RECONNECT.maxAttempts})`);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connectGeneration(false);
		}, delayMs);
		reconnectTimer.unref();
	}
	async function connectGeneration(startup) {
		if (disposed) return;
		let cfg = await store.load();
		if (cfg.appId.trim() === "" || cfg.appSecret.trim() === "") {
			ctx.logger.info(`${label}: no Feishu app credentials — connection deferred until configured`);
			return;
		}
		if (cfg.userAccessToken.trim() !== "") {
			if (await oauth.ensureFresh().catch(() => false)) cfg = await store.load();
		}
		const generation = new Client({
			name: "dsh-feishu",
			version: "0.1.0"
		}, { capabilities: {} });
		let resolveClosed;
		const closed = new Promise((resolve) => {
			resolveClosed = resolve;
		});
		let attemptSettled = false;
		let closeObserved = false;
		client = generation;
		clientClosed = closed;
		generation.onclose = () => {
			closeObserved = true;
			resolveClosed();
			if (attemptSettled) generationDown(generation);
		};
		generation.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			if (!isCurrent(generation)) return;
			ctx.logger.info(`${label}: tool list changed, re-syncing`);
			try {
				await enqueueSync(generation);
			} catch (error) {
				if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`);
			}
		});
		try {
			transport = new StdioClientTransport(buildServerParams(cfg));
			await generation.connect(transport);
			if (closeObserved) {
				attemptSettled = true;
				generationDown(generation);
				return;
			}
			await enqueueSync(generation);
		} catch (error) {
			if (isCurrent(generation)) ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}`);
			try {
				await generation.close();
			} catch {}
			const quiesced = closeObserved || await waitForClose(closed);
			attemptSettled = true;
			if (!isCurrent(generation)) return;
			if (!quiesced) {
				client = null;
				clientClosed = null;
				ctx.logger.error(`${label}: failed generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms — reconnect stopped; restart the Host to retry`);
				return;
			}
			generationDown(generation);
			return;
		}
		attemptSettled = true;
		if (closeObserved) {
			generationDown(generation);
			return;
		}
		if (!isCurrent(generation)) return;
		await store.recordConnected();
		scheduleWatchdog();
		if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${RECONNECT.maxAttempts})`);
	}
	/** Quit the current generation (if any) and reconnect, e.g. after OAuth token change. */
	async function restart() {
		if (disposed) return;
		failedAttempts = 0;
		const old = client;
		if (old !== null) {
			client = null;
			clientClosed = null;
			transport = null;
			try {
				await old.close();
			} catch {}
		}
		await connectGeneration(false);
	}
	return {
		async start() {
			failedAttempts = 0;
			await connectGeneration(true);
		},
		restart() {
			return restart();
		},
		isConnected() {
			return client !== null;
		},
		toolCount() {
			return disposers.size;
		},
		async listTools() {
			if (client === null) throw new Error("Feishu MCP 未连接。");
			return (await listToolsAll(client)).map((tool) => tool.name);
		},
		async dispose() {
			disposed = true;
			if (reconnectTimer !== null) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			if (watchdogTimer !== null) {
				clearTimeout(watchdogTimer);
				watchdogTimer = null;
			}
			const current = client;
			const currentClosed = clientClosed;
			client = null;
			clientClosed = null;
			if (current !== null) {
				try {
					await current.close();
				} catch {}
				if (currentClosed !== null && !await waitForClose(currentClosed)) ctx.logger.error(`${label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during disposal`);
			}
			await syncChain;
			for (const dispose of disposers.values()) dispose();
			disposers = /* @__PURE__ */ new Map();
		}
	};
}
//#endregion
//#region src/routes.ts
/** Route paths. */
const FEISHU_API = {
	config: "/api/dsh-feishu/config",
	status: "/api/dsh-feishu/status",
	test: "/api/dsh-feishu/test",
	tools: "/api/dsh-feishu/tools",
	oauthStart: "/api/dsh-feishu/oauth/start",
	oauthCallback: "/api/dsh-feishu/oauth/callback",
	oauthFinish: "/api/dsh-feishu/oauth/finish",
	oauthRefresh: "/api/dsh-feishu/oauth/refresh"
};
/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 256 * 1024;
/** Strict loopback fence for all routes. */
function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** One JSON response. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > MAX_JSON_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** Tiny success/error HTML page for the loopback OAuth callback. */
function oauthCallbackPage(title, body) {
	return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>" + title + "</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;background:#f6f7f9;color:#1f2328}.card{background:#fff;border:1px solid #e2e5e9;border-radius:12px;padding:32px 40px;max-width:520px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 12px}p{font-size:14px;line-height:1.7;margin:0}</style></head><body><div class=\"card\"><h1>" + title + "</h1><p>" + body + "</p></div></body></html>";
}
/** Build every /api/dsh-feishu route (exact paths). */
function makeRoutes(deps) {
	const { store, supervisor, oauth, callbackUrl } = deps;
	const guard = (req, res, method) => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: `method not allowed: ${req.method}` });
			return false;
		}
		return true;
	};
	return [
		{
			kind: "exact",
			path: FEISHU_API.config,
			handler: async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					writeJson(res, 200, await store.view());
					return;
				}
				if (method === "POST") {
					if (!guard(req, res, "POST")) return;
					const body = await readJsonBody(req);
					if (body === void 0) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					if (body.reset === true) {
						await store.clearAll();
						writeJson(res, 200, await store.view());
						return;
					}
					writeJson(res, 200, await store.patch(body));
					return;
				}
				writeJson(res, 405, { error: `method not allowed: ${method}` });
			}
		},
		{
			kind: "exact",
			path: FEISHU_API.status,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, {
					...await store.view(),
					connected: supervisor.isConnected(),
					toolCount: supervisor.toolCount()
				});
			}
		},
		{
			kind: "exact",
			path: FEISHU_API.test,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const connected = supervisor.isConnected();
					const tools = connected ? await supervisor.listTools() : [];
					writeJson(res, 200, {
						ok: connected,
						message: connected ? `已连接 Feishu MCP，发现 ${tools.length} 个工具。` : "Feishu MCP 未连接（请先配置 App ID / App Secret）。",
						connected,
						toolCount: tools.length,
						tools
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						message: "测试失败: " + String(error instanceof Error ? error.message : error),
						connected: false,
						toolCount: 0,
						tools: []
					});
				}
			}
		},
		{
			kind: "exact",
			path: FEISHU_API.tools,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				try {
					writeJson(res, 200, { tools: supervisor.isConnected() ? await supervisor.listTools() : [] });
				} catch (error) {
					writeJson(res, 200, {
						tools: [],
						error: String(error instanceof Error ? error.message : error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: FEISHU_API.oauthStart,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const { authorizeUrl, state } = await oauth.begin(callbackUrl);
					writeJson(res, 200, {
						ok: true,
						authorizeUrl,
						state,
						callbackUrl
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						error: String(error instanceof Error ? error.message : error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: FEISHU_API.oauthCallback,
			handler: async (req, res) => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				const code = url.searchParams.get("code") ?? "";
				const state = url.searchParams.get("state") ?? "";
				const error = url.searchParams.get("error");
				if (error !== null) {
					res.writeHead(200, {
						"content-type": "text/html; charset=utf-8",
						"referrer-policy": "no-referrer"
					});
					res.end(oauthCallbackPage("授权失败", "飞书返回错误：" + error + "。可关闭此页面后重试。"));
					return;
				}
				const result = code !== "" ? await oauth.complete(code, state) : {
					ok: false,
					message: "回调中没有 code 参数。"
				};
				if (result.ok) await supervisor.restart().catch(() => {});
				res.writeHead(result.ok ? 200 : 400, {
					"content-type": "text/html; charset=utf-8",
					"referrer-policy": "no-referrer"
				});
				res.end(result.ok ? oauthCallbackPage("授权成功", "飞书 MCP 授权已完成，user_access_token 已保存。现在可以关闭此页面，回到 DSH。") : oauthCallbackPage("授权失败", result.message));
			}
		},
		{
			kind: "exact",
			path: FEISHU_API.oauthFinish,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const code = typeof body?.code === "string" ? body.code : "";
				const state = typeof body?.state === "string" ? body.state : "";
				if (code.trim() === "") {
					writeJson(res, 200, {
						ok: false,
						message: "缺少 code：请把飞书回调地址里的 code 参数交给本接口。"
					});
					return;
				}
				const result = await oauth.complete(code.trim(), state.trim());
				if (result.ok) await supervisor.restart().catch(() => {});
				writeJson(res, 200, {
					ok: result.ok,
					message: result.message
				});
			}
		},
		{
			kind: "exact",
			path: FEISHU_API.oauthRefresh,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const result = await oauth.refreshToken();
				if (result.ok) await supervisor.restart().catch(() => {});
				writeJson(res, 200, {
					ok: result.ok,
					message: result.message
				});
			}
		}
	];
}
//#endregion
//#region src/oauth.ts
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
/** Default Feishu (China) API domain. */
const DEFAULT_DOMAIN = "https://open.feishu.cn";
/** Lark (international) API domain. */
const LARK_DOMAIN = "https://open.larksuite.com";
/** Normative error text for a Feishu token-endpoint error body. */
function tokenErrorText(body) {
	const record = typeof body === "object" && body !== null ? body : {};
	const code = typeof record.error === "string" ? record.error : typeof record.error_code === "number" ? String(record.error_code) : "";
	const description = typeof record.error_description === "string" ? record.error_description : "";
	const mcpCode = typeof record.code === "number" ? record.code : "";
	const mcpMsg = typeof record.msg === "string" ? record.msg : "";
	const parts = [];
	if (mcpCode !== "" || mcpMsg !== "") parts.push(`${mcpCode}: ${mcpMsg}`.trim());
	if (code !== "" || description !== "") parts.push(`${code}${description ? ": " + description : ""}`.trim());
	return parts.filter(Boolean).join(" · ") || "未知错误";
}
/**
* Feishu-native OAuth orchestration shared by the routes, the agent tools,
* and the supervisor's token refresh. `begin` builds the authorize URL;
* `complete` exchanges the code; `refresh`/`ensureFresh` keeps the token
* current.
*/
var FeishuOAuthFlow = class {
	store;
	pending = null;
	constructor(store) {
		this.store = store;
	}
	/** Whether an authorization flow is currently pending (and not stale). */
	get pendingFlow() {
		const pending = this.pending;
		if (pending === null) return null;
		if (Date.now() - pending.startedAt > 6e5) {
			this.pending = null;
			return null;
		}
		return pending;
	}
	/** Abort any pending flow (used by clear/reset). */
	abort() {
		this.pending = null;
	}
	/** Short token endpoint for the configured domain. */
	tokenUrl(cfg) {
		return `${cfg.domain?.trim() || "https://open.feishu.cn"}/open-apis/authen/v2/oauth/token`;
	}
	/** Short authorize URL host for the configured domain. */
	authorizeUrl(cfg) {
		return `${cfg.domain?.trim() || "https://open.feishu.cn"}/open-apis/authen/v1/authorize`;
	}
	/**
	* Start an authorization: validate the app credentials, generate a CSRF
	* `state`, and build the Feishu authorize URL for the browser.
	*/
	async begin(callbackUrl, scopeOverride) {
		const cfg = await this.store.load();
		if (cfg.appId.trim() === "") throw new Error("尚未配置飞书 App ID：请先填写 App ID / App Secret。");
		if (cfg.appSecret.trim() === "") throw new Error("尚未配置飞书 App Secret：请先填写 App ID / App Secret。");
		this.pending = null;
		const state = randomUUID();
		this.pending = {
			state,
			redirectUri: callbackUrl,
			startedAt: Date.now()
		};
		const scope = scopeOverride !== void 0 && scopeOverride.trim() !== "" ? scopeOverride.trim() : cfg.scope.trim() !== "" ? cfg.scope.trim() : "offline_access";
		const url = new URL(this.authorizeUrl(cfg));
		url.searchParams.set("client_id", cfg.appId.trim());
		url.searchParams.set("response_type", "code");
		url.searchParams.set("redirect_uri", callbackUrl);
		url.searchParams.set("scope", scope);
		url.searchParams.set("state", state);
		url.searchParams.set("prompt", "consent");
		return {
			authorizeUrl: url.toString(),
			state
		};
	}
	/**
	* Complete the flow with the authorization code (auto callback or a paste).
	* Verifies `state` (empty `state` accepts the single pending flow),
	* exchanges the code for tokens, and persists them.
	*/
	async complete(code, state) {
		const pending = this.pendingFlow;
		if (pending === null) return {
			ok: false,
			message: "没有待完成的飞书授权流程：请先发起登录授权。"
		};
		if (state !== "" && pending.state !== state) return {
			ok: false,
			message: "state 校验未通过（授权流程可能已过期或重复）。请重新发起登录授权。"
		};
		this.pending = null;
		const cfg = await this.store.load();
		if (cfg.appId.trim() === "" || cfg.appSecret.trim() === "") return {
			ok: false,
			message: "缺少应用凭据：请先配置 App ID / App Secret。"
		};
		try {
			const token = await this.exchange({
				grant_type: "authorization_code",
				code,
				client_id: cfg.appId.trim(),
				client_secret: cfg.appSecret.trim(),
				redirect_uri: pending.redirectUri
			});
			await this.store.saveUserTokens(token);
			return {
				ok: true,
				message: "授权成功：飞书 user_access_token 已保存，MCP 工具已就绪。"
			};
		} catch (error) {
			return {
				ok: false,
				message: "领取令牌失败：" + String(error instanceof Error ? error.message : error)
			};
		}
	}
	/** Force a refresh of the user_access_token (verifies the refresh flow). */
	async refreshToken() {
		const cfg = await this.store.load();
		if (cfg.userRefreshToken.trim() === "") return {
			ok: false,
			message: "没有 refresh_token：请重新发起登录授权（需在 scope 中保留 offline_access）。"
		};
		if (cfg.appId.trim() === "" || cfg.appSecret.trim() === "") return {
			ok: false,
			message: "缺少应用凭据：请先配置 App ID / App Secret。"
		};
		try {
			const token = await this.exchange({
				grant_type: "refresh_token",
				refresh_token: cfg.userRefreshToken.trim(),
				client_id: cfg.appId.trim(),
				client_secret: cfg.appSecret.trim()
			});
			await this.store.saveUserTokens(token);
			return {
				ok: true,
				message: "刷新成功：飞书 user_access_token 已更新。"
			};
		} catch (error) {
			return {
				ok: false,
				message: "刷新失败：" + String(error instanceof Error ? error.message : error)
			};
		}
	}
	/**
	* Refresh the user_access_token if it is missing, expired, or within
	* REFRESH_SKEW_MS of expiry (and a refresh_token exists). Returns true
	* when a refresh happened — the supervisor reconnects so the spawned
	* lark-mcp picks up the new token via the USER_ACCESS_TOKEN env var.
	*/
	async ensureFresh() {
		const cfg = await this.store.load();
		if (cfg.userAccessToken.trim() === "") return false;
		if (cfg.userTokenExpiresAt > 0 && cfg.userTokenExpiresAt - Date.now() > 6e4) return false;
		if (cfg.userRefreshToken.trim() === "") return false;
		return (await this.refreshToken()).ok;
	}
	/** Raw token request to authen/v2/oauth/token (JSON body, no auth header). */
	async exchange(body) {
		const cfg = await this.store.load();
		const response = await fetch(this.tokenUrl(cfg), {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify(body)
		});
		const data = await response.json().catch(() => ({}));
		const record = typeof data === "object" && data !== null ? data : {};
		if ((typeof record.code === "number" ? record.code : -1) !== 0 || !response.ok || typeof record.access_token !== "string" || record.access_token === "") throw new Error("飞书 OAuth 令牌接口返回错误：" + tokenErrorText(record));
		return {
			access_token: String(record.access_token),
			refresh_token: typeof record.refresh_token === "string" ? record.refresh_token : "",
			expires_in: typeof record.expires_in === "number" ? record.expires_in : 0,
			refresh_token_expires_in: typeof record.refresh_token_expires_in === "number" ? record.refresh_token_expires_in : 0,
			token_type: typeof record.token_type === "string" ? record.token_type : "Bearer",
			scope: typeof record.scope === "string" ? record.scope : ""
		};
	}
};
//#endregion
//#region src/index.ts
/** Stable cordis plugin name. */
const name = "feishu-mcp";
/** Services required before the plugin surfaces can mount. */
const inject = [
	"webServer",
	"tools",
	"systemPrompt"
];
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 210;
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const FEISHU_GUIDANCE = "本机已安装 dsh-feishu 插件（飞书 OpenAPI MCP 连接）：驱动官方 @larksuiteoapi/lark-mcp 服务器，把飞书开放平台 API 封装为 mcp__feishu__* 工具（IM 消息、多维表格 Bitable、云文档、日历、云盘等，具体以连接后发现的工具为准）。工具：feishu_status（状态）、feishu_config（配置 App ID / App Secret / 用户令牌）、feishu_test（测试连接并列出工具）、feishu_tools（列出工具）、feishu_oauth_start（发起浏览器跳转授权）、feishu_oauth_finish（用回调 code 完成授权）、feishu_oauth_refresh（刷新用户令牌）。前提：需先在飞书开放平台创建企业自建应用并添加所需权限（im/bitable/docx/calendar/drive 等），把 App ID / App Secret 配置进插件，并把重定向 URL 设为 " + FEISHU_API.oauthCallback + "（在应用「安全设置→重定向 URL」配置）。如需以用户身份访问私有资源：先 feishu_oauth_start 拿到授权链接，指导用户在浏览器登录飞书并授权（scope 需含需要的 API 权限 + offline_access），授权后自动回填 user_access_token；也可用 feishu_oauth_refresh 刷新。用户提到「飞书 / Feishu / Lark / 多维表格 / 发飞书消息」时即指本插件，请据此协作。";
/** One text content block (the only render shape these tools emit). */
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/** Status tool: config + connection state. */
function feishuStatusTool(ctx) {
	return defineTool({
		name: "feishu_status",
		description: "查看 dsh-feishu 插件状态：是否已配置飞书 App ID/Secret、是否已连接 MCP、已注册的飞书工具数量、最近连接时间。不会泄露任何密钥。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					configured: { type: "boolean" },
					connected: { type: "boolean" },
					toolCount: { type: "number" },
					appIdMasked: { type: "string" },
					hasAppSecret: { type: "boolean" },
					hasUserToken: { type: "boolean" },
					userTokenExpiresAt: { type: "number" },
					userRefreshExpiresAt: { type: "number" },
					scope: { type: "string" },
					domain: { type: "string" },
					tokenUpdatedAt: { type: "string" },
					configPath: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			try {
				const view = await ctx.store.view();
				const parts = [
					"飞书配置：" + (view.configured ? "已配置（App ID " + view.appIdMasked + "）" : "未配置（请用 feishu_config 设置 App ID / App Secret）"),
					"MCP 连接：" + (ctx.supervisor.isConnected() ? "已连接" : "未连接"),
					"已注册工具：" + ctx.supervisor.toolCount() + " 个（mcp__feishu__*）",
					"用户令牌：" + (view.hasUserToken ? "已配置" : "未配置（tenant 身份，如需访问私有资源请在浏览器登录授权）")
				];
				if (view.hasUserToken && view.userTokenExpiresAt > 0) {
					const minutes = Math.max(0, Math.floor((view.userTokenExpiresAt - Date.now()) / 6e4));
					parts.push("令牌剩余：约 " + minutes + " 分钟（可用 feishu_oauth_refresh 刷新）");
				}
				if (view.tokenUpdatedAt) parts.push("最近连接：" + view.tokenUpdatedAt);
				return {
					ok: true,
					message: parts.join("\n"),
					...view,
					connected: ctx.supervisor.isConnected(),
					toolCount: ctx.supervisor.toolCount()
				};
			} catch (error) {
				return {
					ok: false,
					message: "读取状态失败: " + String(error instanceof Error ? error.message : error)
				};
			}
		}
	});
}
/** Config tool: update Feishu credentials. */
function feishuConfigTool(ctx) {
	return defineTool({
		name: "feishu_config",
		description: "配置 dsh-feishu 飞书凭据：appId/appSecret（飞书开放平台企业自建应用的 App ID / App Secret）、userAccessToken/userRefreshToken（可选，用户身份令牌）、scope（可选，登录授权请求的权限列表，需含 offline_access 才能拿到 refresh_token）、domain（可选，飞书 API 域名，默认 https://open.feishu.cn，Lark 国际版用 https://open.larksuite.com）、extraArgs（可选，传给 lark-mcp 的额外 CLI 参数，如 -t 工具预设）。配置持久化到 ~/.dsh/dsh-feishu.json（0600）。传 reset: true 清除全部凭据。",
		parameters: {
			appId: {
				type: "string",
				description: "飞书 App ID（开放平台创建应用获取）"
			},
			appSecret: {
				type: "string",
				description: "飞书 App Secret"
			},
			userAccessToken: {
				type: "string",
				description: "可选：用户访问令牌（user_access_token，访问私有资源时用）"
			},
			userRefreshToken: {
				type: "string",
				description: "可选：用户刷新令牌"
			},
			scope: {
				type: "string",
				description: "可选：登录授权请求的 scope（空格分隔，建议含 offline_access + 需要的 API 权限）"
			},
			domain: {
				type: "string",
				description: "可选：飞书 API 域名（默认 https://open.feishu.cn）"
			},
			extraArgs: {
				type: "array",
				items: { type: "string" },
				description: "可选：额外 CLI 参数（如 -t preset）"
			},
			reset: {
				type: "boolean",
				description: "清除全部凭据"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					configured: { type: "boolean" },
					appIdMasked: { type: "string" },
					configPath: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute(args) {
			try {
				if (args !== void 0 && args.reset === true) {
					await ctx.store.clearAll();
					return {
						ok: true,
						message: "已清除飞书凭据。",
						configured: false,
						appIdMasked: "",
						configPath: (await ctx.store.view()).configPath
					};
				}
				const view = await ctx.store.patch(args);
				return {
					ok: true,
					message: view.configured ? "飞书凭据已保存（App ID " + view.appIdMasked + (view.hasUserToken ? "，含用户令牌" : "") + "）。重启或下次连接时生效。" : "飞书凭据不完整：需要 App ID 与 App Secret。",
					configured: view.configured,
					appIdMasked: view.appIdMasked,
					configPath: view.configPath
				};
			} catch (error) {
				return {
					ok: false,
					message: "配置失败: " + String(error instanceof Error ? error.message : error)
				};
			}
		}
	});
}
/** Test tool: probe the MCP connection and list tools. */
function feishuTestTool(ctx) {
	return defineTool({
		name: "feishu_test",
		description: "测试 dsh-feishu 飞书 MCP 连接：确认连接有效并列出服务器当前提供的全部工具名（mcp__feishu__* 的前身工具名）。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					connected: { type: "boolean" },
					toolCount: { type: "number" },
					tools: {
						type: "array",
						items: { type: "string" }
					}
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			try {
				const connected = ctx.supervisor.isConnected();
				const tools = connected ? await ctx.supervisor.listTools() : [];
				return {
					ok: connected,
					message: connected ? `已连接飞书 MCP，共 ${tools.length} 个工具：\n${tools.join("\n")}` : "飞书 MCP 未连接（请先配置 App ID / App Secret 并等待连接）。",
					connected,
					toolCount: tools.length,
					tools
				};
			} catch (error) {
				return {
					ok: false,
					message: "测试失败: " + String(error instanceof Error ? error.message : error),
					connected: false,
					toolCount: 0,
					tools: []
				};
			}
		}
	});
}
/** Tools tool: list the MCP server's tools. */
function feishuToolsTool(ctx) {
	return defineTool({
		name: "feishu_tools",
		description: "列出 dsh-feishu 飞书 MCP 服务器当前提供的全部工具名（mcp__feishu__* 的前身工具名）。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					tools: {
						type: "array",
						items: { type: "string" }
					}
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			try {
				if (!ctx.supervisor.isConnected()) return {
					ok: false,
					message: "飞书 MCP 未连接（请先配置 App ID / App Secret）。",
					tools: []
				};
				const tools = await ctx.supervisor.listTools();
				return {
					ok: true,
					message: "飞书工具（" + tools.length + " 个）：\n" + tools.join("\n"),
					tools
				};
			} catch (error) {
				return {
					ok: false,
					message: "列工具失败: " + String(error instanceof Error ? error.message : error),
					tools: []
				};
			}
		}
	});
}
/** OAuth start tool: build the Feishu authorize URL for the browser. */
function feishuOauthStartTool(ctx) {
	return defineTool({
		name: "feishu_oauth_start",
		description: "发起飞书浏览器跳转授权：构造飞书授权页面链接（authen/v1/authorize），让用户在浏览器登录飞书并同意授权，授权完成后自动回调本机并把 user_access_token 存进插件。返回 authorizeUrl（让用户用浏览器打开）与回调地址。",
		parameters: { scope: {
			type: "string",
			description: "可选：覆盖授权 scope（空格分隔；默认用配置的 scope，缺省为 offline_access）。需含离线访问权限 offline_access 才能拿到 refresh_token。"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					authorizeUrl: { type: "string" },
					state: { type: "string" },
					callbackUrl: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute(args) {
			try {
				const scope = typeof args?.scope === "string" ? args.scope : void 0;
				const { authorizeUrl, state } = await ctx.oauth.begin(ctx.callbackUrl, scope);
				return {
					ok: true,
					message: "已在飞书发起跳转授权，请让用户在浏览器打开以下链接完成登录授权（授权后自动回调 " + ctx.callbackUrl + " 并保存 user_access_token）：\n\n" + authorizeUrl,
					authorizeUrl,
					state,
					callbackUrl: ctx.callbackUrl
				};
			} catch (error) {
				return {
					ok: false,
					message: "发起授权失败: " + String(error instanceof Error ? error.message : error)
				};
			}
		}
	});
}
/** OAuth finish tool: exchange a callback code (manual paste path). */
function feishuOauthFinishTool(ctx) {
	return defineTool({
		name: "feishu_oauth_finish",
		description: "用飞书回调地址里的 code 完成授权：当浏览器未自动回调（或用户把回调 URL 里的 code 粘贴回来）时，把 code（可带 state）交给本工具换取 user_access_token。",
		parameters: {
			code: {
				type: "string",
				description: "授权回调地址里的 code 参数"
			},
			state: {
				type: "string",
				description: "可选：回调地址里的 state 参数（校验用）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute(args) {
			try {
				const code = typeof args?.code === "string" ? args.code.trim() : "";
				const state = typeof args?.state === "string" ? args.state.trim() : "";
				if (code === "") return {
					ok: false,
					message: "缺少 code：请把飞书回调 URL 里的 code 参数传给我。"
				};
				const result = await ctx.oauth.complete(code, state);
				return {
					ok: result.ok,
					message: result.message
				};
			} catch (error) {
				return {
					ok: false,
					message: "完成授权失败: " + String(error instanceof Error ? error.message : error)
				};
			}
		}
	});
}
/** OAuth refresh tool: refresh the user_access_token. */
function feishuOauthRefreshTool(ctx) {
	return defineTool({
		name: "feishu_oauth_refresh",
		description: "刷新 dsh-feishu 的 user_access_token：用已保存的 refresh_token 换一个新的用户令牌（需要授权时 scope 含 offline_access）。令牌过期或临近过期时调用。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			try {
				const result = await ctx.oauth.refreshToken();
				return {
					ok: result.ok,
					message: result.message
				};
			} catch (error) {
				return {
					ok: false,
					message: "刷新失败: " + String(error instanceof Error ? error.message : error)
				};
			}
		}
	});
}
/** Build the tool list for registration. */
function buildTools(ctx) {
	return [
		feishuStatusTool(ctx),
		feishuConfigTool(ctx),
		feishuTestTool(ctx),
		feishuToolsTool(ctx),
		feishuOauthStartTool(ctx),
		feishuOauthFinishTool(ctx),
		feishuOauthRefreshTool(ctx)
	];
}
/**
* Mount the Feishu MCP tools, routes, announcement, and supervised connection.
* @param ctx - host plugin context carrying webServer/tools/systemPrompt.
* @param config - plugin config from the composition row.
*/
function apply(ctx, config) {
	const announceToAgent = config?.announceToAgent !== false;
	const enabled = config?.enabled !== false;
	const store = new FeishuStore();
	const oauth = new FeishuOAuthFlow(store);
	const callbackUrl = `http://127.0.0.1:${ctx.webServer.port}${FEISHU_API.oauthCallback}`;
	const supervisor = createSupervisor(ctx, store, oauth);
	const context = {
		store,
		supervisor,
		oauth,
		callbackUrl
	};
	let disposeTools;
	let disposeRoutes;
	let disposeSection;
	const sync = () => {
		if (disposeTools !== void 0) {
			disposeTools();
			disposeTools = void 0;
		}
		if (disposeRoutes !== void 0) {
			disposeRoutes();
			disposeRoutes = void 0;
		}
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		if (!enabled) return;
		disposeTools = ctx.effect(() => {
			const disposers = buildTools(context).map((tool) => ctx.tools.register(tool));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-feishu: tools");
		disposeRoutes = ctx.effect(() => {
			const disposers = makeRoutes(context).map((route) => ctx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-feishu: routes");
		if (announceToAgent) disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-feishu",
			order: SECTION_ORDER,
			text: FEISHU_GUIDANCE
		});
	};
	sync();
	(async () => {
		if (!enabled) return;
		if ((await store.view()).configured) supervisor.start().catch(() => {});
	})();
	ctx.effect(() => {
		return () => {
			supervisor.dispose();
		};
	}, "dsh-feishu: connection");
}
//#endregion
export { DEFAULT_CONFIG_FILE, DEFAULT_DOMAIN, FEISHU_API, FEISHU_GUIDANCE, FeishuOAuthFlow, FeishuStore, LARK_DOMAIN, apply, buildServerParams, buildTools, configPath, createSupervisor, defineTool, feishuConfigTool, feishuOauthFinishTool, feishuOauthRefreshTool, feishuOauthStartTool, feishuStatusTool, feishuTestTool, feishuToolsTool, inject, makeRoutes, mask, name, publicToolName };
