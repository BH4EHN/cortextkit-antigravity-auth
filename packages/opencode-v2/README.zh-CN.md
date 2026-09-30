# opencode-v2-antigravity

面向 **OpenCode 2.x** 的 Google Antigravity provider，基于
[`@cortexkit/antigravity-auth-core`](https://www.npmjs.com/package/@cortexkit/antigravity-auth-core) 实现。

`@cortexkit/opencode-antigravity-auth` 面向 OpenCode 1.x 宿主
（`engines.opencode: ">=1.17.13 <2"`）：它通过劫持 `fetch()` 并注册 TUI 侧边栏来工作。
OpenCode 2.x 用新的插件 API 取代了这些接口（`session.hook`、`integration.transform`、
原生 provider 包），因此 1.x 插件无法在 2.x 中加载。本包补上了这层宿主适配：
OAuth、传输、账号池轮换、限流记录与模型注册表仍然全部复用共享 core。

> **服务条款警告。** 本项目调用 Antigravity 的非公开内部 API，未获 Google 认可，可能违反
> Google 服务条款；已有账号因类似用法被限制的报告。请自行评估风险，不要使用重要账号。

## 设计

```
OpenCode 2.x                          本插件                        Antigravity
────────────                          ──────                        ───────────
原生 @opencode-ai/ai/providers/google
  构造 Gemini 请求      ──▶  session.hook("http.request")
                                将 URL 改写为 127.0.0.1 回环地址
                                       │
                                       ▼
                             回环 HTTP 服务
                                · 选择账号（hybrid 策略）
                                · 刷新 OAuth token
                                · ensureProjectContext()
                                · agent 信封 + labels/sessionId
                                · fetchWithAgyCliTransport()  ──▶  daily-cloudcode-pa
                                                                    （回退 cloudcode-pa）
                                       │
  解析 Gemini SSE       ◀───────  解包并规范化后的 SSE
```

保留原生 `@opencode-ai/ai/providers/google` 作为编解码器，意味着图片、PDF 和 tool call
都交由宿主处理，不需要手写 adapter。

为什么使用回环服务，而不是在 hook 里直接返回 `Response`：OpenCode 2.x 会把 hook 留下的
`event.request` 交给自己的 HTTP 客户端发送，而 `http.response` hook 只在该请求成功之后才会执行。
回环端点既保留了 core 的原始 HTTP/1.1 传输（agy 的 header 顺序、代理支持），又让宿主看到一个
可以正常流式读取与取消的 SSE 响应。

`oc-plugin` 清单同时启用 server 与 TUI 入口。server 负责 provider 请求和账号操作；
TUI 注册三个 `/antigravity-*` 命令、独立会话面板和首页插件页面。`/rpc` 定义两者之间的
类型化通信接口。

## 安装

```bash
npm install @cortexkit/opencode-v2-antigravity-auth
# 或从本仓库（Bun workspace）：
bun install
bun run build
```

在 `opencode.json` 中注册 npm 包和 Antigravity 模型。使用本地检出时，请先在仓库根目录运行
`bun install` 和 `bun run build`，然后注册包目录的绝对路径
（`/path/to/antigravity-auth/packages/opencode-v2`）。完整模型配置见
[`example/opencode.json`](example/opencode.json)。

```jsonc
{
  "plugins": ["@cortexkit/opencode-v2-antigravity-auth"],
  "providers": {
    "google": {
      "models": {
        "gemini-3.8-flash": {
          "name": "Gemini 3.8 Flash",
          "modelID": "gemini-3.8-flash",
          "package": "@opencode-ai/ai/providers/google",
          "capabilities": { "tools": true, "input": ["text", "image", "pdf"], "output": ["text"] },
          "limit": { "context": 1048576, "output": 65536 },
          "variants": [{ "id": "low" }, { "id": "medium" }, { "id": "high" }]
        }
      }
    }
  }
}
```

## 账号

- 账号池文件：OpenCode 配置目录下的 `antigravity-accounts.json`
  （`$OPENCODE_CONFIG_DIR`、`$XDG_CONFIG_HOME/opencode`、`%APPDATA%\opencode`
  或 `~/.config/opencode`），可用 `ANTIGRAVITY_ACCOUNTS_FILE` 覆盖。
  存储结构为 v4，并使用 core 的文件锁，因此与 1.x 插件、独立 CLI 共享同一份数据。
- 添加账号：连接 `google` integration，选择
  **“Google Antigravity (add account)”**。每次登录都是**追加**，不会覆盖已有账号。
  回调监听 `127.0.0.1:51121/oauth-callback`。
- 停用账号：把该条目设为 `"enabled": false`。
- 账号选择使用 core 的 `hybrid` 策略。`401` 只强制刷新一次 token，`429` 会记录限流状态并轮换；
  明确的 `ACCOUNT_INELIGIBLE` / `VALIDATION_REQUIRED` 会先停用受影响账号，再选择其他账号。
  最终传输和 SSE 错误会进入 OpenCode 原生错误路径。

## TUI 命令

在 OpenCode 2 的 TUI 中使用 `/antigravity-account`、`/antigravity-quota` 和
`/antigravity-status`。命令在会话中打开独立面板；从首页运行时打开插件页面，
不会向 AI 会话添加消息或调用模型。账号用 `Account 1` 等序号表示，不显示邮箱。

- `/antigravity-account [list|use <n>|enable <n>|disable <n>]` 查看或调整账号池。
  已启用但仍需验证的账号在验证完成前不会被 OpenCode 2 选用。
- `/antigravity-account remove <n>` 仅预览；追加 `confirm` 才会删除。
- `/antigravity-account add` 显示 OAuth 地址，并在面板中跟踪完成状态。
- `/antigravity-quota [refresh]` 查看缓存或刷新实时额度。
- `/antigravity-status` 查看账号池与缓存状态。

若 TUI 命令未加载，服务器会在提示词进入 provider 请求前拒绝以这三个斜杠命令开头的输入。
若 OAuth 已写入账号池但运行中的适配器无法重新加载，面板会提示重启 OpenCode；
若无法确认写入结果，请先检查账号池再尝试登录。若适配器能重新读取账号文件，
其他账号和命令仍可继续使用；只有无法重新加载账号文件时才需要重启。
恢复时不会重放失败的命令；core 加载器仍按既有规则迁移旧版账号池，并备份损坏文件。

## 模型

| 选择器 | 变体 | 实际下发模型 |
| --- | --- | --- |
| `google/gemini-3.8-flash` | low, medium, high | `gemini-3.8-flash-{tier}` |
| `google/gemini-3.7-flash` | low, medium, high | `gemini-3.7-flash-{tier}` |
| `google/gemini-3.6-flash` | low, medium, high | `gemini-3.6-flash-{tier}` |
| `google/gemini-3.5-flash` | low, medium, high | `gemini-3.5-flash-extra-low` / `gemini-3.5-flash-low` / `gemini-3-flash-agent` |
| `google/gemini-3.1-pro` | low, high | `gemini-3.1-pro-low` / `gemini-pro-agent` |
| `google/gemini-3.1-flash-image` | — | `gemini-3.1-flash-image` |
| `google/claude-sonnet-4-6-thinking` | — | `claude-sonnet-4-6` |
| `google/claude-opus-4-6-thinking` | — | `claude-opus-4-6-thinking` |
| `google/gpt-oss-120b-medium` | — | `gpt-oss-120b-medium` |

模型 id 与推理档位来自 `resolveModelForHeaderStyle()`，注册表仍是唯一事实来源。

## 已绕过的宿主/上游问题

1. **GPT-OSS 的工具 schema**：AGY 的 GPT 桥接会把 protobuf 数值约束重新编码为字符串，
   于是 `minLength: 1` 在 OpenAI JSON-Schema 校验中失败，返回 `400 INVALID_ARGUMENT`。
   对 `gpt-*` 下发模型调用
   `normalizeGeminiTools(request, { moveNumericConstraintsToDescription: true })` 即可解决。
2. **原生事件 schema 很严格**：GPT-OSS 的首帧只有 `content` 而没有 `parts`，Claude 有时使用
   `assistant` 角色，两者都会触发 `Invalid google/gemini stream event`。
   因此每一帧在转发前都会被规范化。
3. **响应编码**：core 传输层已经解压 gzip，因此上游的 `content-encoding` 头不能复制到
   回环响应上。
4. **图片输出**：图片模型的标题请求会路由到受支持的 Gemini 3.5 Flash low 层级；图片请求会移除不支持的工具和 thinking 配置。
   生成图片以私有权限写入 `~/.opencode/generated-images/`，再以文本形式告知路径。

## 日志与隐私

`<state dir>/antigravity-v2.log` 只记录路由、`#<账号序号>`、上游状态码、账号轮换与已保存图片路径；
不写入任何 prompt、token、邮箱或 refresh token。凭据只保存在由 core 管理的账号池文件中。

## 验证

确定性的 OpenCode 2 E2E 套件会启动真实、固定版本的宿主二进制，并显式设置隔离的
`OPENCODE_DB`。CI 和发布流程会在禁用容器网络的 Docker 环境中运行同一套测试，确保无法访问实时端点。测试覆盖真实 hook 路由、最终 AGY 请求结构、账号不适用状态的落盘与轮换、图片和日志文件权限，以及传输错误、SSE 内嵌错误和干净 EOF 的原生错误传播。

## 许可证

MIT。
