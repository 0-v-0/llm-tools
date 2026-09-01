# 配置文件迁移：环境变量 → config.toml

## 背景

img-search 与 img-val 最初通过环境变量管理调优参数。img-search 有约 12 个调优环境变量（`IMGSEARCH_ALPHA`、`IMGSEARCH_LAMBDA`、`IMGSEARCH_BEAM_SIZE`、`IMGSEARCH_TOPK_QUESTIONS` 等），img-val 有约 6 个（`IMGVAL_STANDARDS_DIR`、`IMGVAL_STORE_RAW`、`IMGVAL_MAX_IMAGE_DIMENSION`、`IMGVAL_MAX_TOOL_ROUNDS`、`IMGVAL_FAIL_LOG`、`LLM_ENABLE_TOOLS`）。

随着参数数量增长，环境变量方案的痛点逐渐显现：

- **缺乏类型安全与范围校验**：布尔值需手写 `string → boolean` transform，数值范围只能靠运行时隐式失败。
- **默认值分散**：默认值散落在 `env.ts` 的 zod schema 中，难以一览全貌，用户无法从单一来源了解全部可调项。
- **环境变量污染**：十余个 `IMG*` 前缀变量挤占 shell 环境，与 LLM provider 配置（`OPENAI_API_KEY` 等）混杂，难以区分用途。

## 核心决策

将全部调优参数从环境变量迁移至 TOML 配置文件，由各子项目 `src/config/config.ts` 加载。

- **配置文件路径**：`<数据目录>/config.toml`（img-search）/ `<数据目录>/config.toml`（img-val），文件不存在时使用全部默认值，不报错。
- **解析与校验**：`smol-toml` 解析 → zod schema 校验（含类型约束、范围限制、默认值）。解析失败抛 `ConfigError`，校验失败报告全部 issue。
- **保留的环境变量**（`env.ts` 仅留）：LLM provider 配置（`LLM_PROVIDER`、`OPENAI_*`、`ANTHROPIC_*`）与数据目录定位变量（`IMGVAL_DB_DIR` / `IMGSEARCH_DB_DIR`）。
- **新增模块**：`src/config/config.ts`（各子项目独立 schema + `loadConfig()`）；`src/config/paths.ts` 新增 `getConfigPath()`。
- **配置为唯一来源**：迁移后的参数不再提供同名环境变量覆盖。

核心模块：各子项目 `src/config/config.ts`（TOML 解析 + zod 校验）、`src/config/env.ts`（仅保留 LLM provider 与数据目录变量）、`src/config/paths.ts`（配置文件路径定位）。

## 权衡分析

**方案 A：保留环境变量**（12-Factor App 风格）

- 优点：shell 友好，支持逐次调用覆盖（`IMGVAL_MAX_TOOL_ROUNDS=8 imgval value ...`），无需额外配置文件。
- 缺点：十余个变量缺乏类型安全；默认值分散在 zod transform 链中难以维护；布尔值转换易错。

**方案 B：迁移至 config.toml**（已选择）

- 优点：结构化格式，zod 校验类型与范围；默认值集中在 schema 声明中，自文档化；不污染 shell 环境。
- 缺点：丧失逐次调用的环境变量覆盖能力（用户需编辑配置文件）；新增 `smol-toml` 依赖。

选择 B 的关键依据：调优参数的特点是**数量多、类型多样（数值/布尔/字符串）、设置后很少逐次变更**。环境变量的逐次覆盖优势在此场景下收益甚微，而类型安全与集中默认值的收益显著。

## 影响范围

- **Breaking Change**：以下环境变量被移除，用户需将其值迁移至对应的 `config.toml`：
  - img-search：`IMGSEARCH_ALPHA`、`IMGSEARCH_LAMBDA`、`IMGSEARCH_BEAM_SIZE`、`IMGSEARCH_TOPK_QUESTIONS`、`IMGSEARCH_CANDIDATE_QUESTIONS`、`IMGSEARCH_IG_THRESHOLD`、`IMGSEARCH_MAX_ROUNDS`、`IMGSEARCH_MIN_ROUNDS`、`IMGSEARCH_SHOW_THUMBNAILS`、`IMGSEARCH_MAX_IMAGE_DIMENSION`、`IMGSEARCH_IMPORT_CONCURRENCY`、`IMGSEARCH_EMBED_TEXT_BATCH`、`IMGSEARCH_EMBED_IMAGE_BATCH`
  - img-val：`LLM_ENABLE_TOOLS`、`IMGVAL_STANDARDS_DIR`、`IMGVAL_STORE_RAW`、`IMGVAL_MAX_IMAGE_DIMENSION`、`IMGVAL_MAX_TOOL_ROUNDS`、`IMGVAL_FAIL_LOG`
- 保留的环境变量不变：`LLM_PROVIDER`、`OPENAI_*`、`ANTHROPIC_*`、`IMGVAL_DB_DIR` / `IMGSEARCH_DB_DIR`。
- 后续统一数据目录决策（见 [`unified-data-dir.md`](unified-data-dir.md)）将配置文件名从 `config.toml` 改为工具前缀名（`imgval.toml` / `imgsearch.toml`）。
