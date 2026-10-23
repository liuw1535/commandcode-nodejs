# Responses 格式转换交接记录

- 记录日期：2026-10-21
- 范围：`POST /v1/responses` 请求/响应格式转换，以及 Responses SSE 流式事件
- 当前状态：A、B 两类问题已修复（logprobs / usage 细节 / SSE `event:` 行 / 工具空参数 / 响应对象补全 / instructions 数组 / input_file 语义 / encrypted_content / 多模态 tool output）；C 类（请求参数透传）仍待处理
- 验证情况：`npm test` 通过（120 项），新增回归测试覆盖上述修复

## 结论

文本、reasoning、`function_call`、字符串形式的 `function_call_output`、`tools`、`reasoning.effort`、`max_output_tokens` 以及流式 `response.*` 生命周期的主链路转换是正确的，抓包中的上游事件也能映射。

但实现不是完整的 OpenAI Responses schema，部分字段缺失或会被静默改写，少数场景存在数据丢失和语义错误。

对照文档：<https://developers.openai.com/api/reference/resources/responses/methods/create>

## 待处理问题

> A、B 两类已修复，下文各小节保留原始记录以备追溯；已修复项不再影响上游请求体或仅修正其内容。C 类仍未处理。

### P0：`output_text` 缺少 `logprobs`

官方 `ResponseOutputText` 形状为：

```json
{
  "type": "output_text",
  "text": "...",
  "annotations": [],
  "logprobs": []
}
```

当前实现只输出 `type/text/annotations`，没有 `logprobs`。严格客户端可能出现解析问题。

涉及位置：

- `src/responsesConverter.js:313`：非流式 message item
- `src/responsesStreamMapper.js:186`：`response.content_part.added`
- `src/responsesStreamMapper.js:205`：`response.content_part.done`
- `src/responsesStreamMapper.js:212`：`response.output_item.done` 中的 message
- `src/responsesStreamMapper.js:341`：`response.output_text.delta`
- `src/responsesStreamMapper.js:441`：空输出的兜底 message

建议：所有 `output_text` part 和文本增量/完成事件统一补 `logprobs: []`（当前不返回 logprobs，因此固定空数组）。

### P0：usage 字段不完整

官方 usage 包含：

```json
{
  "input_tokens": 0,
  "input_tokens_details": {
    "cached_tokens": 0,
    "cache_write_tokens": 0
  },
  "output_tokens": 0,
  "output_tokens_details": {
    "reasoning_tokens": 0
  },
  "total_tokens": 0
}
```

当前只映射 `input_tokens`、`output_tokens`、`total_tokens`，以及在存在 `cachedInputTokens` 时映射 `input_tokens_details.cached_tokens`。缺少 `output_tokens_details.reasoning_tokens` 和 `input_tokens_details.cache_write_tokens`。

上游 usage 中已有 `reasoningTokens`；`inputTokenDetails` 中还有 `noCacheTokens/cacheReadTokens`，可用于补齐或推导。

涉及位置：

- `src/responsesConverter.js:392`：非流式 usage
- `src/responsesStreamMapper.js:449`：流式 `response.completed.usage`

建议：集中实现一个 `mapUsage()`，两种模式共用，避免字段继续分叉。

### P0：`instructions` 为数组时被忽略

官方当前允许 `instructions` 是字符串或 input item 数组。当前实现只处理字符串：

```js
if (typeof instructions === 'string' && instructions) {
  systemTexts.push(instructions);
}
```

数组形式会被静默丢弃，导致 system/developer 指令缺失。

涉及位置：

- `src/responsesConverter.js:143`

建议：复用 input message 的文本提取逻辑，支持 `instructions: InputItem[]`。

### P0：`input_file` 转换错误且有损

当前实现：

- `file_data` 被替换为 `[file: filename]` 占位文本，文件内容直接丢失
- `file_url` 被转换成 `{ type: "image", source: { type: "url", ... } }`，把文件当图片
- `file_id` 没有处理

如果上游确实不支持文件输入，应明确返回 400 或记录 warning 后丢弃，不能伪装成图片或静默丢内容。

涉及位置：

- `src/responsesConverter.js:59`

### P0：`reasoning.encrypted_content` 被当作明文 reasoning

当前逻辑在 `summary` 为空时，把 `encrypted_content` 直接作为 `{ type: "reasoning", text }` 发给上游：

- `src/responsesConverter.js:226`

`encrypted_content` 是 OpenAI 的加密载荷，不是可读的思维链文本。把它作为 reasoning 文本发送会污染上游上下文，也不符合语义。

建议：

- 只使用 `summary[].text`
- 没有 summary 时丢弃该 reasoning item，或明确报不支持
- 不要把 `encrypted_content` 拼进 `reasoning` block

同时注意：当前输出端也不会生成 `encrypted_content`，因此请求里的 `include: ["reasoning.encrypted_content"]` 也无法被满足。

### P1：SSE 缺少 `event:` 行

官方 Responses 流式示例同时输出：

```text
event: response.created
data: {"type":"response.created",...}
```

当前 `sseData()` 只写 `data:` 行：

```js
res.write(`data: ${JSON.stringify(obj)}\n\n`);
```

涉及位置：

- `src/responsesStreamMapper.js:70`

很多客户端只读 `data` 里的 `type`，所以 Codex 可能不受影响；但严格按 SSE 解析的客户端会不兼容。

建议：写成 `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`，同时保留 `sequence_number`。

### P1：部分请求参数未透传

当前 `responsesToCommandCode()` 只把 `max_output_tokens` 和 `reasoning.effort` 传给 `assembleCcBody`，以下字段被忽略：

- `tool_choice`
- `parallel_tool_calls`
- `text.format` / structured outputs
- `truncation`
- `temperature`
- `top_p`
- message item 的 `phase`（`commentary` / `final_answer`）
- `include`

涉及位置：

- `src/responsesConverter.js:264`
- `src/responsesConverter.js:165`（message 分支未读取 `phase`）

其中 `tool_choice` 和 `phase` 可能实际影响模型行为，需要确认上游是否支持；不支持时至少应记录 warning 或写入文档限制。

### P1：`function_call_output` 的多模态输出被丢弃

官方 `function_call_output.output` 可以是字符串，也可以是 `input_text` / `input_image` / `input_file` 数组。

当前数组分支只取 `p.text`：

```js
item.output.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n')
```

因此 `input_image`、`input_file` 会变成空字符串，内容静默丢失。

涉及位置：

- `src/responsesConverter.js:204`

建议：文本继续拼接，非文本 part 记录 warning；如果上游支持图片 tool result，再补对应映射。

### P2：流式工具调用可能输出非法空参数

`closeTool()` 在既没有收到最终结构化 `tool-call`、也没有收到参数 delta 时，会使用空字符串：

```js
const args = (t.input != null) ? JSON.stringify(t.input) : (t.args || '');
```

无参数函数的 `arguments` 应该是合法 JSON 字符串 `"{}"`，而不是 `""`。

涉及位置：

- `src/responsesStreamMapper.js:263`

建议：回退值改为 `t.args || '{}'`。

### P2：响应对象是精简版

非流式和 `response.completed` 只返回了核心字段：

```json
{ "id", "object", "created_at", "status", "model", "output" }
```

官方 Response 对象还包含 `completed_at`、`error`、`instructions`、`max_output_tokens`、`parallel_tool_calls`、`previous_response_id`、`reasoning`、`store`、`temperature`、`text`、`tool_choice`、`tools`、`top_p`、`truncation`、`usage`、`user`、`metadata` 等。

Codex 通常只消费 `output`、`status`、`usage` 等字段，因此优先级较低；但对 schema 严格校验的客户端可能不兼容。

## 修复优先级建议

已完成（本次）：
1. ✅ 补 `logprobs: []` 和 usage 细节字段
2. ✅ 支持 `instructions` 数组
3. ✅ 修正 `input_file`、`encrypted_content` 的静默错误
4. ✅ 补 SSE `event:` 行
5. ✅ 统一响应对象和 usage 的公共构造逻辑（`mapUsage()` / `buildResponseObject()`），补响应字段、工具空参数 `'{}'`、多模态 tool output warning，补回归测试

未完成（待后续）：
6. ⏳ 确认并处理 `tool_choice`、`phase`、`temperature`/`top_p`/`truncation`/`include` 等请求参数（C 类，需先验证上游 `/alpha/generate` 是否接受这些字段，不可盲目透传进 `params`，否则会触发上游 400）

## 备注

- `previous_response_id` 已经在路由层明确返回 400，这是有意的无状态限制。
- `store` 当前无效果，客户端需要重发完整 `input`。
- 修复时建议为每个问题补最小回归测试，避免只测试当前实现自己的输出形状。
