# Configuration

## 加载顺序

配置按以下优先级加载，高优先级覆盖低优先级：

1. 环境变量
2. `config.json`
3. `config.js` 内置默认值

`config.json` 缺失时服务仍可启动。文件存在但 JSON 非法时会直接启动失败。配置文件支持部分字段，缺失字段会与内置默认值深合并。

使用 `CONFIG_FILE` 可以指定其他配置文件路径。

## 常用环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CONFIG_FILE` | `./config.json` | 配置文件路径 |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `AUTH_TOKEN` | 空 | 本地鉴权密钥；未设置时关闭鉴权 |
| `MAX_BODY_BYTES` | `104857600` | 请求体大小上限，超过返回 `413` |
| `CREDENTIALS_FILE` | `./credentials.json` | 凭证文件路径 |
| `STATE_DIR` | `./.state` | 凭证状态目录 |
| `COMMANDCODE_BASE` | `https://api.commandcode.ai` | 上游地址 |
| `MODELS_REFRESH_MS` | `600000` | 模型列表刷新间隔；`0` 关闭定时刷新 |
| `REASONING_EFFORT` | `high` | 默认推理强度 |
| `MAX_TOKENS` | `64000` | 默认最大输出 token |

## 上游与请求行为

| 变量 | 默认值 | 说明 |
|---|---|---|
| `COMMANDCODE_USER_AGENT` | `cli` | 模拟的 CLI `User-Agent` |
| `CLI_VERSION` | `1.50.1` | 模拟的 CLI 版本号 |
| `RETRY_429_MAX` | `3` | 同一 token 的 429 重试次数 |
| `RETRY_429_BASE_MS` | `1000` | 429 指数退避基数 |

## 指纹与遥测

以下配置主要用于控制上游请求的模拟行为。除非明确理解影响，否则建议保持默认值。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PROJECT_SLUG` | 每凭证随机 | 项目 slug；固定值会让多个凭证产生关联 |
| `HW_MACHINE_POOL` | 内置硬件组合 | 每凭证硬件画像抽取池，JSON 数组 |
| `HW_OS_RELEASES` | 内置 Windows 版本 | 每凭证 Windows 版本抽取池 |
| `NODE_VERSION_POOL` | 内置 Node 版本 | 遥测 span 中的 Node 版本抽取池 |
| `TELEMETRY_AXIOM_URL` | `config.json` | Axiom 上报地址 |
| `TELEMETRY_AXIOM_TOKEN` | `config.json` | Axiom token |
| `TELEMETRY_AXIOM_DATASET` | `config.json` | Axiom dataset |
| `TELEMETRY_CLAICODE_URL` | `config.json` | claicode 上报地址 |
| `TELEMETRY_CLAICODE_TOKEN` | `config.json` | claicode token |

## 配置文件

`config.json` 集中维护以下数据：

- 遥测 token、dataset 和上报端点
- CLI 版本号
- 上游地址和 API 路径
- 默认模型
- 硬件画像池
- 指纹静态字段
- OTel User-Agent 和 service name

`AUTH_TOKEN` 只能通过环境变量设置，不应写入 `config.json`。

`MODEL_MAP` 已移除。模型列表由上游 `/provider/v1/models` 提供；如需模型别名，请在客户端侧处理。
