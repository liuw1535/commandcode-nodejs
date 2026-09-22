# Command Code API Proxy

将 Command Code 上游代理为 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 兼容接口，可直接接入支持这些协议的客户端与 Claude Code。

## 运行要求

- Node.js 18 或更高版本
- 至少一个以 `user_` 开头的 Command Code token
- 无第三方 npm 依赖

## 快速开始

```bash
cp credentials.example.json credentials.json
# 编辑 credentials.json，填入真实 token

cp config.example.json config.json

export AUTH_TOKEN=your-local-secret
export PORT=3000
npm start
```

服务默认监听 `http://0.0.0.0:3000`。未设置 `AUTH_TOKEN` 时不启用本地鉴权，服务仍会给出启动警告。

## 凭证

`credentials.json` 支持一个 token 数组：

```json
[
  { "token": "user_xxxxx...", "name": "acct-1", "enabled": true },
  { "token": "user_yyyyy...", "name": "acct-2", "enabled": false }
]
```

- `token` 必须以 `user_` 开头。
- `name` 可选，仅用于日志显示。
- `enabled` 可选，默认 `true`；设为 `false` 后该凭证不参与轮询。
- 可用 `CREDENTIALS_FILE` 指定其他凭证文件路径。

服务会自动轮询可用凭证；遇到 429 时退避重试，遇到额度耗尽时禁用对应凭证并切换到下一个。

## 常用配置

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `AUTH_TOKEN` | 空 | 本地鉴权 token；为空时关闭鉴权 |
| `CREDENTIALS_FILE` | `./credentials.json` | 凭证文件路径 |
| `CONFIG_FILE` | `./config.json` | 配置文件路径 |
| `STATE_DIR` | `./.state` | 凭证状态持久化目录 |
| `REASONING_EFFORT` | `high` | 默认推理强度 |
| `MAX_TOKENS` | `64000` | 默认最大输出 token |

完整配置项和加载优先级见 [`docs/configuration.md`](docs/configuration.md)。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/messages/count_tokens` | Anthropic token 数粗估 |
| `GET` | `/v1/models` | 可用模型列表 |
| `GET` | `/health` | 健康检查 |
| `GET` | `/v1/credentials/status` | 凭证状态，需要鉴权 |

本地鉴权同时接受以下任一请求头：

```text
Authorization: Bearer <AUTH_TOKEN>
x-api-key: <AUTH_TOKEN>
```

### OpenAI 示例

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "messages": [{"role": "user", "content": "你是谁？"}],
    "stream": true
  }'
```

### Anthropic 示例

```bash
curl http://localhost:3000/v1/messages \
  -H "x-api-key: $AUTH_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "数到3"}],
    "stream": false
  }'
```

## 模型

模型列表来自上游 `GET /provider/v1/models`，并通过 `/v1/models` 返回。请求中的模型名会按大小写不敏感方式匹配；未命中时原样透传给上游。

如果省略 `model`，使用 `config.json` 中的 `models.defaultModel`。

## Claude Code 接入

```bash
export ANTHROPIC_BASE_URL=http://<host>:3000
export ANTHROPIC_AUTH_TOKEN=<AUTH_TOKEN>
export ANTHROPIC_MODEL=zai-org/GLM-5.3
claude
```

也可以使用 `ANTHROPIC_API_KEY`；该模式会通过 `x-api-key` 请求头发送鉴权 token。

## Codex 接入

Codex 仅支持 Responses 协议（`wire_api` 唯一合法值为 `"responses"`），本代理已实现 `/v1/responses`，可直连，无需额外的协议转换层。

在用户级 `~/.codex/config.toml` 中配置自定义 provider（注意：`model_provider` / `model_providers` 写在项目级 `.codex/config.toml` 中会被忽略；内置 ID `openai` / `ollama` / `lmstudio` 为保留字，不能用）：

```toml
model = "zai-org/GLM-5.3"
model_provider = "commandcode"

[model_providers.commandcode]
name = "Command Code"
base_url = "http://<host>:3000/v1"
env_key = "COMMANDCODE_API_KEY"
wire_api = "responses"
```

然后设置鉴权并启动：

```bash
export COMMANDCODE_API_KEY=<AUTH_TOKEN>
codex
```

- 鉴权也可以不用环境变量，直接在 provider 中写 `experimental_bearer_token = "<AUTH_TOKEN>"`。
- 本地鉴权未启用（`AUTH_TOKEN` 为空）时，可省略 `env_key`，此时 Codex 认为端点无需认证，直接请求即可。
- 顶层 `preferred_auth_method` 只作用于内置 `openai` provider 的登录方式，对自定义 provider 无效（且已在 Codex 0.35.0 中移除），无需配置。
- 可选调优：`request_max_retries`（默认 4）、`stream_idle_timeout_ms`（默认 300000）。

## 兼容性概览

- 支持 OpenAI 与 Anthropic 的流式和非流式请求。
- 支持函数调用、工具调用往返、图片和 reasoning 输出。
- Anthropic token 计数为本地估算，不请求上游。
- 部分官方参数不支持时会静默忽略；`previous_response_id` 会返回明确错误。

协议映射、事件流和已知限制见 [`docs/api-compatibility.md`](docs/api-compatibility.md)。

## 更多文档

- [`docs/configuration.md`](docs/configuration.md)：配置文件、环境变量和加载优先级
- [`docs/architecture.md`](docs/architecture.md)：请求链路、模块结构、模型缓存和凭证策略
- [`docs/api-compatibility.md`](docs/api-compatibility.md)：三种 API 的具体兼容行为
