# dsh-feishu — 飞书（Lark）MCP 连接插件 for DeepSeek Harness

把 DeepSeek Harness（DSH）与[飞书开放平台](https://open.feishu.cn/)打通：插件以子进程方式驱动**官方** [@larksuiteoapi/lark-mcp](https://www.npmjs.com/package/@larksuiteoapi/lark-mcp) 服务器，用你的飞书应用凭据启动它，发现其工具并注册为 agent 的 `mcp__feishu__*` 工具——DSH agent 即可用你飞书应用的权限发送 IM 消息、读写多维表格（Bitable）、管理云文档、日历、云盘等。

Web 设置面板（设置 → 飞书）配置 App ID / App Secret、显示连接状态、列出发现的工具。

> English README: [README.md](README.md)

## 特性

- **官方 MCP 服务器**：stdio 方式驱动 `@larksuiteoapi/lark-mcp`（飞书 OpenAPI MCP，Beta），无需公网 IP、无需反向代理。
- **完整工具面**：官方服务器暴露的所有工具（取决于你的应用权限与 `-t` 预设）都会成为 agent 工具 `mcp__feishu__*`——例如 `mcp__feishu__im_v1_message_create`、`mcp__feishu__bitable_v1_app_create`。
- **应用身份或用户身份**：配置 `appId`/`appSecret`（应用身份，tenant），可选 `userAccessToken`（用户身份，访问私有资源）。
- **agent 工具**：`feishu_status` / `feishu_config` / `feishu_test` / `feishu_tools`。
- **Web 设置面板**：配置凭据、测试连接、查看实时工具列表。

## 前置条件

1. 一个飞书自建应用：[飞书开放平台](https://open.feishu.cn/) → 开发者后台 → 创建应用。
2. 添加所需权限（`im:message`、`bitable:app`、`docx:document`、`calendar:calendar`、`drive:drive` 等）并发布版本。
3. 安装插件并配置 **App ID / App Secret**。

## 安装

```sh
# 本地开发（link）
dsh plugin --profile web add link:/path/to/dsh-feishu
# 重启 dsh web 生效
```

## 配置

通过 Web 设置面板（设置 → 飞书），或用 agent 工具：

```
feishu_config appId=<cli_xxx> appSecret=<你的secret>
```

可选用户身份（访问私有资源）：

```
feishu_config userAccessToken=<user_access_token>
```

## 使用

连接成功后，agent 会把飞书工具以 `mcp__feishu__*` 前缀暴露。验证：

```
feishu_test
```

## 开发

```sh
pnpm install
pnpm build && node tests/smoke.mjs
```

## License

MIT
