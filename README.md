# 隐盾安全智能体 · 演示 AI 中转站

独立于其它项目的轻量中转服务：**Cloudflare Pages Functions**，把「隐盾安全智能体」的 AI 请求
转发到 **OpenCode Go**（`https://opencode.ai/zen/go/v1/chat/completions`）。

- API Key 只存在 Cloudflare 环境变量 `OPENCODE_API_KEY` 里，**客户端零凭据**；
- 本仓库任何文件都不包含可用 key；
- 上游地址是代码里的字面量常量，**不接受任何运行时改写**（防 SSRF）。

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/ai/chat/completions` | OpenAI 兼容的对话补全；支持 `tools`（函数调用）与 `stream:true` 透传 |
| `GET` | `/api/ai/healthz` | 健康检查，返回 `{ ok, configured, ts }` |
| `OPTIONS` | 上述两条 | CORS 预检（回显白名单 Origin，绝不返回 `*`） |

其它方法一律 `405 Method Not Allowed`。

## 部署（Cloudflare Pages，约 3 分钟）

1. 先在本仓库创建好 Pages 项目：Cloudflare 控制台 → **Workers 和 Pages → 创建 → Pages → 连接到 Git**，
   选择 `Andysun06/yindun-relay`。
2. 构建配置：框架预设选 **None**，**构建命令留空**，**输出目录留空**（本项目只有 Functions，无静态资源）。
3. **Settings → Environment variables** 添加：
   - `OPENCODE_API_KEY`：你的 OpenCode Go Key，类型选 **Secret / 密钥**（必填）；
   - 可选 `ALLOWED_MODELS`：逗号分隔的模型白名单，默认 `deepseek-v4.1-flash`；
   - 可选 `ALLOWED_ORIGINS`：额外允许的来源（逗号分隔，例如自定义域），默认已放行 `*.pages.dev` 与 localhost。
4. 保存后 **重新部署一次**（环境变量在下一次部署才生效；也可 Deployments → Retry deployment）。
5. 自检：浏览器打开 `https://<项目>.pages.dev/api/ai/healthz`，
   应看到 `{"ok":true,"configured":true,"ts":...}`；`configured:false` 说明第 3 步的变量没生效。

## 客户端接入

在「隐盾安全智能体」里把 AI 的 **Base URL** 填：

```
https://<项目>.pages.dev/api/ai
```

（客户端会拼成 `/api/ai/chat/completions` 与 `/api/ai/healthz`。）

## 上游两个硬要求（已内置，勿删）

| 要求 | 不处理的后果 | 本仓库做法 |
| --- | --- | --- |
| `x-opencode-session` 请求头 | 上游返回 `400 MissingSessionID` | 每个请求生成随机 UUID 并注入 |
| 常规浏览器 `User-Agent` | Cloudflare 拦截，返回 `403 error code 1010` | 固定使用桌面 Chrome UA，不使用 Node/undici 默认 UA |

## 安全设计

| 风险 | 对策 |
| --- | --- |
| Key 被客户端/安装包提取 | Key 只在 Cloudflare 环境变量（Secret），客户端零凭据 |
| 被刷昂贵模型导致欠费 | 模型白名单（默认 `deepseek-v4.1-flash`），名单外自动替换为默认模型 |
| 被当开放代理 / 通用翻墙入口 | 仅两条固定路由，其它方法 405；上游为代码字面量常量 |
| SSRF / 内网探测 | 目标 URL 写死 `https://opencode.ai/...`，无任何运行时可变目标 |
| 跨站盗刷 | CORS 回显白名单 Origin（`*.pages.dev`、localhost、`ALLOWED_ORIGINS`），不使用 `*` |
| 重定向劫持到其它主机 | `redirect:'manual'`，上游返回 3xx 直接判 502 |
| 刷接口耗额度 | 每 IP 滑窗限流 20 次/分钟（`request.ip`） |
| 超大请求体 | ≤1MB（既看 `content-length` 也按实际字节数复核） |
| 超大输出消耗额度 | `max_tokens` 上限 8192 |
| 慢响应拖垮演示 | 客户端未给 `reasoning_effort` 时默认注入 `none`（优先速度） |
| 日志泄露对话内容 | 日志只记录上游状态码 |

> 限流计数在单个 Workers isolate 内存中，属于「防滥用」而非「精确配额」；需要严格执行时请加 Cloudflare
> Rate Limiting 规则或 Durable Object。

## 本地自测（可选）

不部署也能验证：用 Node 22 直接加载 Functions（无需 wrangler），用环境变量传 key，调用
`onRequestGet` / `onRequestPost` 即可。**不要把 key 写进任何文件**，只在命令行里临时导出。

```bash
# 仅示意：key 通过环境变量传入，不落盘
OPENCODE_API_KEY=你的key node your-test-script.mjs
```

## 免责声明

本项目仅用于「隐盾安全智能体」内部演示，请遵守 OpenCode 的服务条款，不要公开分享 key。
