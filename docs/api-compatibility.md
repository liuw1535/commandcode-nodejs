# API Compatibility

## OpenAI Chat Completions

`POST /v1/chat/completions` 支持流式和非流式响应、函数调用、工具调用往返和 `reasoning_content` 输出。

### 工具调用

- `tools[].function` 转换为 Command Code 的 `{name, description, input_schema}`。
- assistant `tool_calls` 和 `tool` 角色结果消息转换为 `tool-call` / `tool-result` 块。
- 上游 `tool-call` 事件转换为 OpenAI `tool_calls`。
- 流式响应中的 `arguments` 原样透传上游拼接的 JSON 字符串。

## OpenAI Responses

`POST /v1/responses` 支持字符串或 Item 数组形式的 `input`、`instructions`、reasoning、流式语义事件和函数调用。

### 请求映射

- `input` + `instructions` 转换为 Command Code `messages` + `system`。
- `function_call`、`function_call_output`、`reasoning` Item 分别还原为 `tool-call`、`tool-result`、`reasoning` 块。
- `reasoning.effort` 转换为 `reasoning_effort`。
- `max_output_tokens` 转换为 `max_tokens`。

### 非流式响应

响应聚合为：

```json
{ "object": "response", "output": [], "usage": {} }
```

`output` 可包含 `reasoning`、`message` 和 `function_call` Item。当上游因长度截断时，`status` 设置为 `incomplete`。

### 流式事件

上游 SSE 转换为 Responses 语义事件：

```text
response.created
output_item.added
output_text.delta
reasoning_summary_text.delta
function_call_arguments.delta
output_item.done
response.completed
```

每个事件携带递增的 `sequence_number`。多步流程中的每段 reasoning 或文本会生成独立 Item，不做累积合并。

### 无状态限制

- 代理不存储历史响应。
- `previous_response_id` 不支持；携带该字段时返回 `400` 和 `previous_response_id_not_supported`。
- `store` 无效果；客户端应全量重发 `input`。
- Codex CLI 的 `store: false` 模式不受影响。

### 内置工具限制

`web_search`、`file_search`、`local_shell`、`mcp` 和 `custom` 等非 `function` 工具不会传给上游，丢弃时会记录 warn 日志。客户端自定义的 `function` 工具正常转换。

## Anthropic Messages

`POST /v1/messages` 支持流式和非流式响应、`tools`、`tool_use` / `tool_result` 往返、`thinking`、多段 `system`、base64 / URL 图片。

### 映射行为

- 鉴权同时接受 `Authorization: Bearer` 和 `x-api-key`。
- `thinking` 响应保留文本，丢弃 `signature`。
- `system` 支持字符串和多段块，并接受 `cache_control`。
- `max_tokens` 缺失时回退到 `MAX_TOKENS`，避免部分客户端因不传该字段而失败。
- `POST /v1/messages/count_tokens` 使用本地字符数估算，约为文本字符数除以 4，不请求上游。

### Anthropic 流式事件

```text
message_start
ping
content_block_start
text_delta
content_block_stop
message_delta
message_stop
```

响应按 Anthropic SSE 格式输出，包含 `event:` 行。

## 已知限制

以下 Anthropic 参数会被静默忽略：

- `stop_sequences`
- `tool_choice`
- `temperature`
- `top_p`
- Anthropic 内置工具

`thinking.budget_tokens` 不映射；推理强度使用代理的 `REASONING_EFFORT` 默认值。
