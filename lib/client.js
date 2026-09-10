window.__ModuleLoader__.load({
	id: "dsh-feishu",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/api.ts
		/** Error carrying the route's JSON error message. */
		var FeishuApiError = class extends Error {
			constructor(message) {
				super(message);
				this.name = "FeishuApiError";
			}
		};
		/** Parse a JSON response or throw a FeishuApiError. */
		async function readJson(response) {
			let body;
			try {
				body = await response.json();
			} catch {
				throw new FeishuApiError(`HTTP ${response.status}: invalid JSON response`);
			}
			if (!response.ok) throw new FeishuApiError(typeof body === "object" && body !== null && typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
			return body;
		}
		/** Plain fetch helper with an error wrapper. */
		async function request(path, init) {
			let response;
			try {
				response = await fetch(path, init);
			} catch (error) {
				throw new FeishuApiError("网络请求失败: " + String(error instanceof Error ? error.message : error));
			}
			return readJson(response);
		}
		/** The Feishu panel API. */
		var FeishuApi = class {
			async getStatus() {
				return request("/api/dsh-feishu/status");
			}
			async setConfig(patch) {
				return request("/api/dsh-feishu/config", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch)
				});
			}
			async reset() {
				return request("/api/dsh-feishu/config", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ reset: true })
				});
			}
			async test() {
				return request("/api/dsh-feishu/test", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({})
				});
			}
			async oauthStart() {
				return request("/api/dsh-feishu/oauth/start", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({})
				});
			}
			async oauthFinish(code, state) {
				return request("/api/dsh-feishu/oauth/finish", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						code,
						...state !== void 0 && state !== "" ? { state } : {}
					})
				});
			}
			async oauthRefresh() {
				return request("/api/dsh-feishu/oauth/refresh", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({})
				});
			}
		};
		//#endregion
		//#region src/client/FeishuPanel.tsx
		/**
		* Feishu settings panel — rendered inside the web settings page
		* (settings.section entry). Configuration form (App ID / App Secret /
		* optional user token), connection status, test-connection button with the
		* discovered tool list, and a reset button. Plain React, no emoji, no
		* external UI package — inline styles only.
		*/
		/** Module-level API client (stateless; the component closes over it). */
		const api = new FeishuApi();
		/** One shared style sheet (kept tiny and theme-agnostic). */
		const s = {
			card: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				maxWidth: "620px",
				padding: "14px 16px",
				borderRadius: "10px",
				border: "1px solid rgba(128,128,128,0.3)",
				fontSize: "13px",
				color: "inherit"
			},
			title: {
				fontWeight: 600,
				fontSize: "13px",
				margin: 0
			},
			status: {
				fontSize: "12px",
				opacity: .85
			},
			statusWarn: {
				fontSize: "12px",
				opacity: .9,
				color: "#c9763a"
			},
			hint: {
				fontSize: "12px",
				opacity: .85,
				lineHeight: "1.5",
				margin: 0
			},
			row: {
				display: "flex",
				gap: "6px",
				alignItems: "center"
			},
			label: {
				fontSize: "12px",
				opacity: .85,
				whiteSpace: "nowrap"
			},
			input: {
				width: "100%",
				boxSizing: "border-box",
				padding: "5px 8px",
				borderRadius: "6px",
				border: "1px solid rgba(128,128,128,0.35)",
				background: "rgba(128,128,128,0.08)",
				color: "inherit",
				fontSize: "12px"
			},
			flex: { flex: 1 },
			button: {
				padding: "4px 10px",
				borderRadius: "6px",
				cursor: "pointer",
				border: "1px solid rgba(128,128,128,0.4)",
				background: "rgba(128,128,128,0.14)",
				color: "inherit",
				fontSize: "12px"
			},
			msg: {
				fontSize: "12px",
				whiteSpace: "pre-wrap",
				wordBreak: "break-all",
				opacity: .9
			},
			list: {
				fontSize: "12px",
				margin: 0,
				paddingLeft: "18px",
				maxHeight: "180px",
				overflowY: "auto"
			}
		};
		/** Status line for the current config view. */
		function statusText(view) {
			if (view === null) return "加载中…";
			const conf = view.configured ? "已配置（App ID " + view.appIdMasked + "）" : "未配置";
			const conn = view.connected ? "已连接" : "未连接";
			let user = "";
			if (view.hasUserToken) user = view.userTokenExpiresAt > 0 ? " · 用户令牌（" + Math.max(0, Math.floor((view.userTokenExpiresAt - Date.now()) / 6e4)) + " 分钟后过期）" : " · 用户令牌";
			return conf + " · MCP " + conn + (view.connected ? "（" + view.toolCount + " 个工具）" : "") + user + (view.tokenUpdatedAt ? " · 最近连接 " + view.tokenUpdatedAt : "");
		}
		/** The Feishu settings panel component. */
		function FeishuPanel() {
			const [view, setView] = (0, react.useState)(null);
			const [appId, setAppId] = (0, react.useState)("");
			const [appSecret, setAppSecret] = (0, react.useState)("");
			const [userToken, setUserToken] = (0, react.useState)("");
			const [scope, setScope] = (0, react.useState)("");
			const [domain, setDomain] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [msg, setMsg] = (0, react.useState)("");
			const [testResult, setTestResult] = (0, react.useState)(null);
			const refresh = (0, react.useCallback)(async () => {
				try {
					const v = await api.getStatus();
					setView(v);
				} catch (error) {
					setMsg("读取状态失败: " + String(error instanceof Error ? error.message : error));
				}
			}, []);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			/** Run one async panel action with busy/message bookkeeping. */
			const run = async (action) => {
				setBusy(true);
				setMsg("");
				try {
					setMsg(await action());
				} catch (error) {
					setMsg("操作失败: " + String(error instanceof Error ? error.message : error));
				} finally {
					setBusy(false);
				}
			};
			const save = () => {
				run(async () => {
					const next = await api.setConfig({
						...appId.trim() !== "" ? { appId } : {},
						...appSecret.trim() !== "" ? { appSecret } : {},
						...userToken.trim() !== "" ? { userAccessToken: userToken } : {},
						...scope.trim() !== "" ? { scope } : {},
						...domain.trim() !== "" ? { domain } : {}
					});
					setView(next);
					if (appId.trim() !== "") setAppId("");
					if (appSecret.trim() !== "") setAppSecret("");
					if (userToken.trim() !== "") setUserToken("");
					if (scope.trim() !== "") setScope("");
					if (domain.trim() !== "") setDomain("");
					return "配置已保存" + (next.configured ? "（App ID " + next.appIdMasked + "）。" : "：还需 App ID 与 App Secret。");
				});
			};
			const testNow = () => {
				run(async () => {
					const result = await api.test();
					setTestResult(result);
					await refresh();
					return result.ok ? "[ok] 已连接：" + result.toolCount + " 个工具" : "[failed] " + result.message;
				});
			};
			/** Start the browser-redirect OAuth and poll until the user token lands. */
			const loginOAuth = () => {
				run(async () => {
					const result = await api.oauthStart();
					if (!result.ok || result.authorizeUrl === void 0) return "发起授权失败：" + (result.error ?? "未知错误") + "（请先保存 App ID / App Secret）";
					if (window.open(result.authorizeUrl, "_blank", "noopener,noreferrer") !== null);
					const started = Date.now();
					await new Promise((resolve) => {
						const timer = setInterval(async () => {
							try {
								const v = await api.getStatus();
								setView(v);
								if (v.hasUserToken || Date.now() - started > 12e4) {
									clearInterval(timer);
									resolve();
								}
							} catch {
								clearInterval(timer);
								resolve();
							}
						}, 1500);
					});
					const final = await api.getStatus();
					setView(final);
					return final.hasUserToken ? "登录授权已完成：user_access_token 已保存，MCP 已切换为用户身份。" : "已打开飞书授权页，等待你在浏览器完成授权（成功后自动保存令牌）。";
				});
			};
			const refreshToken = () => {
				run(async () => {
					const result = await api.oauthRefresh();
					if (result.ok) {
						await refresh();
						return "[ok] " + result.message;
					}
					return "[failed] " + result.message;
				});
			};
			const clearAll = () => {
				run(async () => {
					const next = await api.reset();
					setView(next);
					setTestResult(null);
					return "已清除全部飞书凭据。";
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: s.card,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: s.title,
						children: "飞书 MCP 连接"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: s.hint,
						children: [
							"通过官方 @larksuiteoapi/lark-mcp 服务器把飞书开放平台 API 接入 DSH：配置飞书自建应用的 App ID / App Secret 后，agent 即可用 ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "mcp__feishu__*" }),
							" 工具操作飞书（IM 消息、多维表格 Bitable、云文档、日历、云盘等）。先在",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								href: "https://open.feishu.cn/",
								target: "_blank",
								rel: "noreferrer",
								children: " 飞书开放平台"
							}),
							"创建企业自建应用，添加所需权限（im/bitable/docx/calendar/drive 等）并发布版本。",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}),
							"访问私有资源（私人文档、以用户身份发消息）要登录授权：在应用「安全设置→重定向 URL」加入",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "http://127.0.0.1:3080/api/dsh-feishu/oauth/callback" }),
							"， 再点「登录授权」在浏览器完成认证（scope 需含 offline_access 才可自动刷新）。"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: view !== null && (view.configured || view.connected) ? s.status : s.statusWarn,
						children: statusText(view)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: s.label,
							children: "App ID"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: {
								...s.input,
								...s.flex
							},
							value: appId,
							onChange: (e) => setAppId(e.target.value),
							placeholder: view?.configured ? "已配置，留空不改" : "cli_xxxxxxxxxxxxxxxx"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: s.label,
							children: "App Secret"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: {
								...s.input,
								...s.flex
							},
							type: "password",
							value: appSecret,
							onChange: (e) => setAppSecret(e.target.value),
							placeholder: view?.hasAppSecret ? "已配置，留空不改" : "输入 App Secret"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: s.label,
							children: "用户令牌"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: {
								...s.input,
								...s.flex
							},
							type: "password",
							value: userToken,
							onChange: (e) => setUserToken(e.target.value),
							placeholder: view?.hasUserToken ? "已配置，留空不改" : "可选：user_access_token（建议用登录授权）"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: s.label,
							children: "授权 scope"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: {
								...s.input,
								...s.flex
							},
							value: scope,
							onChange: (e) => setScope(e.target.value),
							placeholder: view?.scope ? "当前：" + view.scope : "如 offline_access + 需要的API权限"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: s.label,
							children: "API 域名"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: {
								...s.input,
								...s.flex
							},
							value: domain,
							onChange: (e) => setDomain(e.target.value),
							placeholder: view?.domain ? "当前：" + view.domain : "默认 https://open.feishu.cn"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: s.button,
								onClick: save,
								disabled: busy,
								children: "保存配置"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: s.button,
								onClick: loginOAuth,
								disabled: busy || !view?.configured,
								children: "登录授权"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: s.button,
								onClick: refreshToken,
								disabled: busy || !view?.hasUserToken,
								children: "刷新令牌"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: s.button,
								onClick: testNow,
								disabled: busy,
								children: "测试连接"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: s.button,
								onClick: clearAll,
								disabled: busy,
								children: "清除凭据"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: s.button,
								onClick: () => void refresh(),
								disabled: busy,
								children: "刷新"
							})
						]
					}),
					testResult !== null && testResult.tools.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: s.hint,
						children: [
							"发现 ",
							testResult.toolCount,
							" 个飞书工具（agent 侧以 mcp__feishu__* 前缀调用）："
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						style: s.list,
						children: testResult.tools.map((t) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t }, t))
					})] }),
					msg !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: s.msg,
						children: msg
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services. */
		const inject = ["slots"];
		/**
		* Register the Feishu settings page.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			try {
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "feishu-mcp",
					order: 330,
					label: () => "飞书"
				}, FeishuPanel));
			} catch (error) {
				console.warn("[dsh-feishu] settings panel registration failed:", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map