# @llm-image/shared

img-* 系列工具（img-val / img-search / img-cleanup 等）共享的基础库。它不提供独立的用户命令，而是为各个工具提供统一的：

- **LLM provider 抽象**：屏蔽 OpenAI / Anthropic 的调用差异，统一多模态消息、工具调用、结构化输出与 logprobs 接口。
- **图片处理**：图片解码、元数据提取、为 LLM 输入做尺寸缩放与转码。
- **SQLite 存储**：数据库打开与迁移执行的基础封装。
- **错误体系**：统一的错误类层级，映射到稳定的进程退出码。

## 安装与使用

本包通过 pnpm workspace 提供给仓库内的其它包消费。在依赖它的子项目（如 img-val、img-search）中：

```bash
pnpm --filter <子项目名> add @llm-image/shared
```

代码中以包名直接导入：

```ts
import { createProvider } from '@llm-image/shared';
```

## 构建要求

- `shared` 需**先编译**，其它包才能解析到它的产物（`dist/`）。
- 单独构建：`pnpm --filter @llm-image/shared build`。
- 部分消费方（img-val、img-cleanup）的 build 脚本会自动先构建 shared；单独开发这些包时，首次需手动执行一次上述构建。
- 类型检查：`pnpm --filter @llm-image/shared typecheck`。

## 公共 API 面

以下符号经包入口聚合导出，构成对外契约（按功能分组）：

### LLM provider

- 类型：`LLMProvider`、`CompleteRequest`、`CompleteResponse`、`LLMMessage`、`ContentBlock`（含 `TextBlock` / `ImageUrlBlock` / `ToolCallBlock` / `ToolResultBlock`）、`ToolDef`、`ToolFunctionDef`、`ResponseSchema`、`ToolCall`、`UsageInfo`、`StopReason`、`LogprobInfo` / `LogprobToken` / `TopLogprob`
- 工厂与校验：`createProvider()`、`validateProviderConfig()`、`createLlmConfigSchema()`、`resolveProviderConfig()`，类型 `ProviderConfig`、`LlmConfig`、`ProviderEnv`
- 具体实现：`OpenAIProvider`、`AnthropicProvider`（两者都满足 `LLMProvider` 接口）

### 图片处理

- `processImage()`：解码图片、提取元数据、按最大边长缩放并重编码，返回 `ProcessedImage`
- 类型：`ProcessedImage`、`ImageFormat`

### 哈希

- `hashBuffer()`：对字节缓冲计算 SHA-256 十六进制摘要

### SQLite 存储

- `openSqlite()`：打开数据库并执行指定目录下的迁移
- 类型：`DB`

### 错误体系

- 错误类：`AppError` 及其子类 `ConfigError`、`StandardError`、`ImageError`、`LLMError`、`StorageError`、`ParseError`
- 类型：`ExitCode`

## 环境要求

- Node.js >= 22。

## 相关文档

- 配置与数据模型的前置决策见根目录 [`../adr/decisions/config-toml-migration.md`](../adr/decisions/config-toml-migration.md) 与 [`../adr/decisions/unified-data-dir.md`](../adr/decisions/unified-data-dir.md)。