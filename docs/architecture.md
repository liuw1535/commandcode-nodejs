# Architecture

## 请求链路

```text
OpenAI / Anthropic client
        |
        | OpenAI or Anthropic-compatible HTTP API
        v
openaiServer.js
        |
        | protocol conversion and stream mapping
        v
converter / responsesConverter / messagesConverter
        |
        | Command Code /alpha/generate body
        v
upstream.js
        |
        | credential polling, fingerprint, fetch, telemetry
        v
Command Code API
```

`openaiServer.js` 负责路由、鉴权和请求体大小限制。协议转换器把三种外部 API 的请求归一化为 Command Code 请求体；流式映射器把上游 SSE 转回对应协议的事件流。

## 模块结构

```text
config.json             可编辑配置数据
config.js               配置加载器
logger.js               终端日志
index.js                入口
src/
  fingerprint.js        指纹模拟
  sessionStore.js       每凭证指纹持久化
  telemetry.js          OTel 遥测上传
  credPool.js           凭证加载、轮询、禁用和重试
  modelProvider.js      上游模型列表拉取与缓存
  converter.js          OpenAI Chat 转换
  responsesConverter.js OpenAI Responses 转换
  ccBody.js             Command Code 请求体装配
  upstream.js           上游请求生命周期
  streamMapper.js       OpenAI Chat SSE 映射
  responsesStreamMapper.js OpenAI Responses SSE 映射
  messagesConverter.js  Anthropic Messages 转换
  messagesStreamMapper.js Anthropic Messages SSE 映射
  openaiServer.js       HTTP 服务器和路由
```

## 模型列表

模型来自上游 `GET /provider/v1/models`，以 OpenAI 模型列表格式返回。

- 启动时同步拉取一次并缓存；失败不阻塞聊天请求。
- 默认每 10 分钟后台刷新一次，间隔由 `MODELS_REFRESH_MS` 控制。
- `/v1/models` 返回缓存列表。
- 请求中的 `model` 按大小写不敏感匹配；命中时替换为规范 id，未命中时原样透传。
- `models.defaultModel` 仅在请求未携带 `model` 时使用。

## 凭证池策略

- 启动时加载并校验凭证；无效 token 被跳过并记录告警。
- 正常请求按可用凭证轮询；发生轮换时会打印由哪个凭证实际服务了本次请求，以及该凭证的指纹标识（`threadId` / `projectSlug` / `thumbmark`）。
- **额度窗口耗尽**（`429` 且响应体带 `rateLimit.window` = `weekly` / `fiveHour`，或预热时 `/alpha/billing/credits` 的 `windowLimits.exceeded` 已置位）：不再退避重试，立刻禁用该 token 并切换到下一个。
  - 禁用状态会写回 `credentials.json`：`enabled: false` 加 `exhaustedUntil` / `exhaustedWindow` / `exhaustedAt`（原子写入，其它字段原样保留）。
  - 进程重启后仍会跳过冷却中的 token，不会再浪费一次必然失败的 `generate` 请求。
  - 到达上游给出的窗口重置时间后自动恢复（`enabled: true`，并清除 `exhausted*` 字段）；如手动把 `enabled` 改回 `true`，则视为人工覆盖，冷却记录被丢弃。
- **临时限流**（`429` 但不带窗口信息）：同一 token 指数退避重试，默认最多 3 次；仍失败则切换到下一个 token，但不禁用。
- `400` 且响应体包含 `insufficient credits`：禁用该 token（本进程内有效，无重置时间），立即切换凭证并重试本次请求。
- 所有 token 均不可用时，返回 `503`，错误信息里带上各凭证的冷却截止时间或禁用原因。
- `GET /v1/credentials/status` 返回各凭证的 `enabled` / `disabled` / `available` / `exhausted`（窗口、重置时间、剩余毫秒、额度用量）状态，需要鉴权。

## 每凭证机器身份

每个 token 首次使用时生成一套稳定的机器身份，不同凭证之间互不关联。指纹相关日志都会带上凭证名（如 `[fingerprint] acct-2-go reused persisted machine identity ...`），轮换后不会出现"用第一个账号指纹"的情况：

- 独立的 `installId`、`sessionId`、`threadId`
- MAC、用户名、主机名和 git 邮箱的 SHA256 哈希，以及派生 `thumbmark`
- 从配置池抽取的硬件画像
- 请求头与请求体一致的 `x-project-slug` 和 `workingDir`
- 遥测 span 中的 Node 版本和进程 pid

硬件指纹、组件数据和 `installId` 持久化在 `STATE_DIR`，重启后保持稳定。`sessionId`、`threadId` 和 pid 每次启动重新生成。

时区保持全局配置，不随凭证随机变化。

## 启动流程

1. 加载配置并校验环境。
2. 加载凭证池，跳过无效项、手动禁用项和仍在额度冷却期的项。
3. 同步拉取一次模型列表；失败时记录告警并继续启动。
4. 初始化 HTTP 服务器。
5. 后台执行指纹模拟、生命周期事件、指纹记录和 billing 探测。
6. 后台定时刷新模型列表。
