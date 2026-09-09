# Command Code → OpenAI 兼容代理

基于抓包分析构建的代理服务，对外暴露标准 OpenAI Chat Completions API，对内转换为 Command Code 的 `/alpha/generate` 请求格式并转发。包含指纹模拟、凭证池轮询、429 重试、400 额度耗尽自动禁用。

## 快速开始

```bash
# 1. 创建凭证文件
cp credentials.example.json credentials.json
# 编辑 credentials.json，填入真实的 user_ 开头的 token

# 2. (可选) 设置本地鉴权与端口
export AUTH_TOKEN=your-local-secret
export PORT=3000

# 3. 启动
npm start
# 或: node index.js
```

## 凭证文件格式 (`credentials.json`)

```json
[
  { "token": "user_xxxxx...", "name": "acct-1", "enabled": true },
  { "token": "user_yyyyy...", "name": "acct-2", "enabled": false }
]
```

- 每项 `token` 必须以 `user_` 开头（否则被跳过并告警）
- `name` 可选，用于日志辨识；缺省时显示 token 尾 6 位
- `enabled` 可选，bool，默认 `true`；设为 `false` 时该凭证不参与轮询、不预热指纹
- 路径可用环境变量 `CREDENTIALS_FILE` 覆盖

## 对外接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/chat/completions` | OpenAI Chat Completions（支持 `stream: true/false`、`tools`、`tool_calls`、`reasoning_content`） |
| GET  | `/v1/models` | 返回可用模型列表 |
| GET  | `/health` | 健康检查，返回可用凭证数 |
| GET  | `/v1/credentials/status` | 各凭证 disabled 状态（需鉴权） |

### 请求示例

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "messages": [{"role":"user","content":"你是谁？"}],
    "stream": true
  }'
```

## 模型映射

默认白名单（可通过 `MODEL_MAP` 环境变量覆盖/扩展）：

| OpenAI 名 | Command Code 名 |
|-----------|-----------------|
| `glm-5.2` / `GLM-5.2` / `gpt-5.2` | `zai-org/GLM-5.2` |

未匹配的模型名原样透传。`MODEL_MAP=glm-5.2=zai-org/GLM-5.2,my-model=zai-org/GLM-5.2`

## 凭证轮询与额度策略

### 每凭证机器身份隔离

每个 token 首次使用时生成一套完整且终身稳定的"机器身份"，互不关联：
- `installId`、`sessionId`、`threadId`（各自独立）
- MAC / 用户名 / 主机名 / git 邮箱四重 SHA256 哈希 + 派生 `thumbmark`
- 硬件画像（CPU 型号/核数/内存/OS 版本）从池中随机抽取
- `x-project-slug` / `workingDir`（随机 Windows 用户名派生，请求头与请求体一致）
- 遥测 span 中的 node 版本与进程 pid

时区保持全局（应匹配出口 IP 归属地，而非随机变化）。

- **400 + body 含 `insufficient credits`**：禁用该 token，立即轮询到下一个，重试本次请求
- **429**：同 token 指数退避重试（默认最多 3 次，`RETRY_429_BASE_MS=1000`）；仍失败则轮询到下一个 token，**不**禁用
- **全部 token 被禁用**：返回 `503` OpenAI 格式错误
- 指纹模拟（whoami / lifecycle-events / fingerprint/record / billing 探测）在启动后台执行，不阻塞服务

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `AUTH_TOKEN` | （空=关闭） | 本地鉴权密钥；未设时启动告警但可访问 |
| `MAX_BODY_BYTES` | `10485760` (10MB) | 请求体大小上限，超出返回 413 |
| `CREDENTIALS_FILE` | `./credentials.json` | 凭证文件路径 |
| `COMMANDCODE_BASE` | `https://api.commandcode.ai` | 上游地址 |
| `CLI_VERSION` | `1.50.1` | 模拟的 CLI 版本号 |
| `PROJECT_SLUG` | （空=每凭证随机） | 每凭证独立的 `c-users-<名>-desktop`；设置则全局固定一个（会带来跨账号关联） |
| `HW_MACHINE_POOL` | 内置 10 款 CPU/内存组合 | 每凭证硬件画像抽取池，JSON 数组 |
| `HW_OS_RELEASES` | 内置 Win10/11 版本号列表 | 每凭证 Windows 版本抽取池 |
| `NODE_VERSION_POOL` | 内置 node 版本列表 | 遥测 span 中模拟的 node 版本抽取池 |
| `MODEL_MAP` | 见上 | 模型映射 |
| `RETRY_429_MAX` | `3` | 429 同 token 重试次数 |
| `RETRY_429_BASE_MS` | `1000` | 429 退避基数 |
| `REASONING_EFFORT` | `high` | 默认推理强度 |
| `MAX_TOKENS` | `64000` | 默认最大输出 token |

## 模块结构

```
config.js              配置（环境变量覆盖）
logger.js              终端日志（项目原有）
src/
  fingerprint.js       指纹模拟（启动序列 + 请求头）
  telemetry.js         OTel 遥测上传（axiom + claicode）
  credPool.js          凭证池：加载/轮询/禁用/429/400
  converter.js         OpenAI ↔ Command Code 格式转换（含工具）
  streamMapper.js       Command Code SSE → OpenAI SSE 转换
  openaiServer.js      HTTP 服务器 + 路由 + 鉴权 + 体积限制
index.js              入口
```

## 工具调用

完整支持 OpenAI function calling 双向转换：
- 请求侧：`tools[].function` → commandcode `{name, description, input_schema}`；assistant `tool_calls` 与 `tool` 角色结果消息正确还原为 commandcode 的 `tool-call` / `tool-result` 块
- 响应侧：上游 `tool-call` 事件 → OpenAI `tool_calls`，流式下 `arguments` 原样透传上游拼接的 JSON 字符串
- 推理内容映射为 OpenAI 扩展字段 `reasoning_content`（非推理模型该字段缺省）

## 运行要求

- Node.js ≥ 18（使用内置 `http` + 全局 `fetch`，**零第三方依赖**）
