# dsh-feishu-mcp — Feishu (Lark) MCP connection for DeepSeek Harness

Connect DeepSeek Harness (DSH) to [Feishu / Lark](https://open.feishu.cn/) through the **official** [@larksuiteoapi/lark-mcp](https://www.npmjs.com/package/@larksuiteoapi/lark-mcp) server: the plugin spawns the official MCP server as a subprocess with your Feishu app credentials, discovers its tools, and registers them on the agent as `mcp__feishu__*` — so the DSH agent can send IM messages, read/write Bitable (multidimensional tables), manage docs, calendar, drive, and more, using your Feishu app's permissions.

A web settings panel (Settings → 飞书) configures the App ID / App Secret, shows connection status, and lists the discovered tools.

> 中文说明见 [README.zh.md](README.zh.md)。

## Features

- **Official MCP server**: drives `@larksuiteoapi/lark-mcp` (Feishu OpenAPI MCP, Beta) over stdio — no reverse proxy, no public IP needed.
- **Full tool surface**: every tool the official server exposes (per your app's permissions and `-t` presets) becomes an agent tool `mcp__feishu__*` — e.g. `mcp__feishu__im_v1_message_create`, `mcp__feishu__bitable_v1_app_create`.
- **App identity or user identity**: configure `appId`/`appSecret` (tenant identity) and optionally a `userAccessToken` (user identity for private resources).
- **Agent tools**: `feishu_status` / `feishu_config` / `feishu_test` / `feishu_tools`.
- **Web settings panel**: configure credentials, test the connection, and see the live tool list.

## Prerequisites

1. A Feishu self-built app: [Feishu Open Platform](https://open.feishu.cn/) → Developer Console → create an app.
2. Add the permissions you need (`im:message`, `bitable:app`, `docx:document`, `calendar:calendar`, `drive:drive` …) and publish a version.
3. Install the plugin and configure the **App ID / App Secret**.

## Install

```sh
# local development (link)
dsh plugin --profile web add link:/path/to/dsh-feishu-mcp
# restart dsh web to activate
```

## Configure

Via the web settings panel (Settings → 飞书), or the agent tool:

```
feishu_config appId=<cli_xxx> appSecret=<your_secret>
```

Optional user identity (for private resources):

```
feishu_config userAccessToken=<user_access_token>
```

## Usage

After connecting, the agent sees the Feishu tools as `mcp__feishu__*`. Verify:

```
feishu_test
```

## Dev

```sh
pnpm install
pnpm build && node tests/smoke.mjs
```

## License

MIT
