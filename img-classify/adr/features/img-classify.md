# ADR: img-classify — 图片互斥分类器 架构决策

- **状态**：已采纳（全部 A1–A17）
- **决策日期**：2026-09-09

## 背景 / 动机

`img-classify` 是基于 LLM 的图片**互斥分类** CLI 工具：给定图片与预定义**互斥类别集合**，调用多模态 LLM 将图片归入**唯一**类别，工具输出连续置信度（由 logprobs 派生，见 A8）；结果入库、按类别查询、按类别统计。

架构与约定严格对齐 `img-val`（commander CLI、`@llm-image/shared` 共享包、`@llm-image/file-index` 文件指纹、zod 校验、SQLite 迁移、TOML 配置、`~/.img-data` 统一数据目录）。与 `img-tagger`（多标签开放集 + 冲突解决）在语义与实现路径上解耦：本工具的类别空间是**封闭**的、类别集**互斥**、**一图一类**。

本文仅记录已敲定的**决策**及其理由与代价，实现细节见文末引用。

## 决策记录

各决策按编号 A1–A17 列出。除注明外均已采纳。

### A1 — 分类标准中类别的组织方式

**决策**：类别**只**在 frontmatter `categories` 数组中列出，Markdown body 是每类别一小节的**类别描述**；`standards/parser.ts` 校验 body 是否覆盖全部 frontmatter 类别，缺失则报错——防止类别名漂移。

**理由**：单一事实来源（frontmatter 的类别名）+ 可读性（body 详述）。parser 的覆盖校验保证两者一致。
**代价**：需维护 frontmatter 与 body 两处的对应关系，靠校验兜底。

### A2 — 无工具级兜底类别

**决策**：取消工具级兜底值。LLM 返回的 `category` 必须严格属于 `standard.frontmatter.categories`；兜底类别由标准作者自行在 `categories` 中声明（如 `other`），工具不做特殊处理——与其它类别同等对待（正常入库、参与统计）。

**理由**：类别空间完全由分类标准决定，工具保持中立；把「是否需要兜底」的语义决定权交还标准作者。
**代价**：标准若未声明兜底类别，则不存在兜底；需由标准编写者负责。

### A3 — 不启用工具调用

**决策**：本工具不做任何工具调用循环，单次 prompt + 直接输出。随 A4 一并确立。

**理由**：一图一类只需输出单个类别标签，无需多步工具循环；单次调用更简洁、延迟更低、无错误恢复循环。
**代价**：放弃工具调用路径的错误恢复能力（本工具不需要）。

### A4 — 直接输出内容 + 约束解码 / `--rationale`

**决策**：LLM **直接输出内容**。输出契约由 `--rationale` 控制：
- 未传 `--rationale`（默认）：仅输出 `category`（JSON：`{"category": "..."}`）；
- 传 `--rationale`：输出 `{ "rationale", "category" }`，且 prompt 引导**先输出原因、后输出类别**（rationale ≤200 字中文）。

类型标签由**约束解码**保证合法：OpenAI `response_format` 的 `category` 字段 `enum = 标准类别列表`（生成期即受限）；Anthropic 无原生 enum 约束，输出文本 JSON 后经程序校验兜底（配合 A6 重试）。

**理由**：约束解码在生成期限制输出，对 OpenAI 是最简可靠路径。
**代价**：Anthropic 无原生 enum 约束，需程序校验兜底。

### A5 — 不做聚类

**决策**：不做聚类；"自动发现新类别"若未来需要，另起工具（`img-cluster`），不复用本工具。

**理由**：聚类与「封闭类别空间 + 互斥」目标冲突，本工具专注确定性分类。
**代价**：需另建 `img-cluster` 工具。

### A6 — 重试策略

**决策**：单图内**额外重试最多 2 次**（`classifyRetries`，默认 2，共最多 3 次尝试），仅对**响应解析失败**重试——`category` 缺失/非法/不在类别空间内、JSON 解析失败，以及传 `--rationale` 时 `rationale` 缺失；LLM API 错误按 shared provider 内置重试（额外重试通常 3 次，共 4 次尝试）；文件级错误不重试。

**理由**：重试针对「输出可纠正」的解析失败而非 provider/文件侧错误，收敛且可控。
**代价**：LLM API 层的额外错误不在此处额外重试。

### A7 — 同图同标准单行

**决策**：`uq_class_hash_standard` 唯一索引，同一图片 + 同一标准**内容**（standard_hash）只保留一行；`--mode full` 显式覆盖时先 `DELETE WHERE image_hash = ? AND standard_hash = ?` 再插入，保持单行不变式。

**理由**：避免"同一标准多次分类"造成历史膨胀；以单行不变式保证查询结果确定。
**代价**：失败记录如需审计，经 failLogDir。

### A8 — 置信度由 logprobs 派生

**决策**：`confidence` 完全来源于 provider 的 logprobs 派生；LLM **不**输出置信度字段。派生方式：请求传 `logprobs: true, top_logprobs: 5`（OpenAI），重建 token 文本后正则定位 `category` 值区间，对该区间重叠 token 的 logprob 求平均，`exp(mean_logprob)` 得 0–1 概率。

**理由**：LLM 自报置信度校准差，logprobs 反映模型对所选类别 token 的 token 级别概率分布，比"自报信心"更客观。
**代价**：依赖 provider 的 logprobs 支持（见 A16）。

### A9 — 入库不固化阈值

**决策**：入库**不**固化任何阈值标志（无 `below_threshold` 字段、无 `min_confidence` 快照、无 `minConfidence` 配置）。阈值完全由查询/统计时 `search`/`stats` 的 `min:`/`max:` 动态指定（每次可不同）。只要响应通过校验一律写库。

**理由**：固化阈值会导致同一图在不同阈值需求下重分类或需冗余字段。
**代价**：查询需实时过滤——对 SQLite 体量不构成性能问题。

### A10 — 简化查询语法

**决策**：`search` 沿用 `img-val` 的 `key:value` 前缀式，不支持 `img-tagger` 式括号/反向/通配。

**理由**：保持「简化查询」目标，`img-tagger` 式语法复杂度较高。
**代价**：功能相对有限，无法表达复杂布尔组合。

### A11 — 顶层默认命令为分类

**决策**：顶层默认命令是 `imgclassify <path|dir>`（图片分类）；`search`/`stats`/`standards`/`images`/`check` 为子命令。

**理由**：分类是最高频操作，放在顶层直达。
**代价**：顶层与子命令命名需在 README 中清晰区隔。

### A12 — 内置默认标准粒度

**决策**：内置默认标准 `default-general` 使用 **12 个类别**（含 `other`）：人像、场景/风景、动物、美食、文档照、商品/物品特写、艺术创作、屏幕截图、手写/简笔画/草图、图形/图表/logo、动画帧、其它。

**理由**：在覆盖度与易用性间平衡，含兜底类别以应对未覆盖内容。
**代价**：比 4–6 类的极简方案更细、比 20+ 类的方案更粗；类别过多会提高 LLM 判别难度。

### A13 — 保留 images prune

**决策**：保留 `images prune` 子命令（清理失效类别/漂移记录）。

**理由**：分类标准变更后会留下失效类别残留与 file-index 漂移记录，需清理入口。
**代价**：多一条维护类命令。

### A14 — `--mode skip|full`，无 `sync`

**决策**：支持 `--mode <skip|full>`，不支持 `sync`（img-val 的 `sync` 用于路径漂移修复）。`skip`（默认）：`image_hash + standard_hash` 均匹配即跳过；`full`：全量重分类。

**理由**：`classification` 表不存文件路径、路径由 file-index 管理，`sync` 对本工具无意义。
**代价**：路径漂移的同步修复不由本工具提供。

### A15 — logprobs 开关仅配置文件控制

**决策**：`enableLogprobs` 仅由配置文件控制，无 CLI 开关。

**理由**：logprobs 是全局置信度策略，属配置层选择，不宜在命令行频繁覆盖。
**代价**：临时切换需改配置文件。

### A16 — Anthropic 无 logprobs

**决策**：Anthropic provider 不支持 logprobs，其路径下 `confidence` = NULL；`stats.avg_confidence` 忽略 NULL；`search min:`/`max:` 阈值筛选忽略 NULL 记录（不匹配）。

**理由**：跨 provider 场景仅比较 `category` 与 `rationale`，不比较置信度。
**代价**：Anthropic 路径无置信度可用，不可与 OpenAI 结果直接比较。

### A17 — 默认禁用失败日志（隐私保护）

**决策**：`failLogDir` 默认设为空串（禁用），且启用时图片内容一律替换为 `[图片内容省略]` 占位符，不记录 EXIF（除非显式 `failLogIncludeExif = true`），仅记录 LLM 分类流程失败。

**理由**：分类处理涉及用户私有图片，默认不落盘敏感内容（原始图片、EXIF/GPS 元数据），降低隐私泄露风险；仅在显式启用时记录诊断信息。
**代价**：默认状态下调试分类失败时缺少详细上下文，需用户手动开启 `failLogDir`。

## 决策与实现对照

| 决策 | 影响模块 / 契约 |
|------|------------------|
| A1 / A2 | `img-classify/src/standards/parser.ts`（frontmatter `categories` + body 覆盖校验）；`standards/loader.ts`（内置/用户标准加载） |
| A3 / A4 | `img-classify/src/classification/tool-flow.ts`（`enableTools=false`）；`response-parser.ts`（OpenAI `response_format` enum / Anthropic 文本 JSON 校验） |
| A5 / A11 / A13 | `img-classify/src/cli/`（顶层分类 `classify.ts` + `search.ts`/`stats.ts`/`standards.ts`/`images.ts`/`check.ts`；无聚类模块） |
| A6 / A14 | `img-classify/src/classification/engine.ts`（重试逻辑 + `--mode skip\|full`） |
| A7 | `img-classify/src/storage/migrations/001_init.sql`（`uq_class_hash_standard` 唯一索引） |
| A8 / A15 / A16 | `img-classify/src/classification/confidence.ts`（logprobs 派生）；`config/config.ts`（`enableLogprobs` 仅配置控制） |
| A9 | `img-classify/src/query/evaluate.ts`（动态 `min:`/`max:` 过滤）；`stats/stats.ts`（过滤后聚合） |
| A10 | `img-classify/src/query/parser.ts`（`key:value` 前缀式语法） |
| A12 | `img-classify/assets/standards/builtin/default-general.md`（打包内置 12 类标准） |
| A17 | `img-classify/src/config/config.ts`（`failLogDir` 默认空串）；`cli/classify.ts`（忽略 EXIF、图片块占位符替换） |

> 产品视角（子命令表见 `DESIGN.md` §1.3、并发约束见 §5）见 `DESIGN.md`；实现细节（CLI 完整选项见 `docs/impl.md` §8、Schema 见 §4、Prompt 见 §5.2、并发控制见 §11）见 `docs/impl.md`。本文件为唯一决策记录；后续若推翻任一决策，在此更新状态（将对应编号的状态改为「已取代」「已拒绝」）并注明原因与日期。
