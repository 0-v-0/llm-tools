# img-cleanup 实现文档

本实现文档依据设计文档 [`../adr/decisions/cleanup-workflow.md`](../adr/decisions/cleanup-workflow.md)，
描述 img-cleanup 的具体实现方式：内部字段、配置键与默认值、checkpoint 文件与
缓存键细节、各阶段实现。本文档随代码演进，不构成对外契约。

## 1. 数据读取与内部字段

### 1.1 数据库定位

- 估值数据库：`<IMGDATA_DIR>/imgval.db`（由 img-val 创建），只读打开，不运行
  迁移、不写入任何私有表。
- 文件索引库：`<IMGDATA_DIR>/fileindex.db`（由 file-index 创建），仅在移动
  文件后更新 URL 记录时写入。

### 1.2 内部行结构（from img-val 的 valuation 表）

每行经内部类型 `ImageEntry` 封装，字段与 SQL 列映射如下：

| ImageEntry 字段 | valuation 表列 | 说明 |
|---|---|---|
| `url` | `url` | 文件 URL（规范解码形式，与 img-val 存储一致） |
| `imageHash` | `image_hash` | 处理后的 BLAKE3 哈希（来自 img-val） |
| `maxValue` | `max_value` | 该 URL 所有估值中的最高估值 |
| `minValue` | `min_value` | 该 URL 所有估值中的最低估值 |
| `standardName` | `standard_name` | 取最高估值所在记录的标准名 |
| `imageFormat` | `image_format` | 图片格式（jpeg/png/webp） |
| `width` | `width` | 像素宽 |
| `height` | `height` | 像素高 |
| `channels` | `channels` | 通道数（可为 null） |
| `sizeBytes` | `size_bytes` | 文件大小（字节） |
| `undecodablePixels` | `undecodable_pixels` | 不可解码像素数（损坏指标） |

查询逻辑：按 URL 聚合取 `MAX(max_value)` 的记录（子查询 + join，避免 GROUP BY
歧义），按 `standard_name, max_value ASC` 排序；随后按 `--path` glob 过滤
本地路径。

### 1.3 命名冲突

- 流程中的「分组/批次」按 `ImageEntry` 处理；`ImageEntry.url` 的本地路径
  由 `src/util/url.ts` 的 `fileUrlToPath` / `toFileUrl` 转换。
- 路径匹配 glob 由 `src/util/path-match.ts` 的 `matchesAnyGlob` 完成。

## 2. 配置键与默认值

### 2.1 配置文件 `~/.img-data/imgcleanup.toml`

顶层键（zod schema，`src/config/config.ts`）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `llm` | 见下 | LLM provider 配置（来自 `@llm-image/shared` 的 schema 工厂） |
| `batchSize` | `2` | 每批次图片数量 n（整数 2–100） |
| `maxImageDimension` | `1568` | 送入 LLM 前最长边像素限制 |
| `bucketBoundaries` | `[0, 30, 100, 500, 2000, 5000, 15000]` | 估值分桶边界（默认对应 default-photo 参考区间） |
| `maxToolRounds` | `4` | LLM 工具调用最大轮次（当前未使用工具，保留备用） |
| `storeRaw` | `false` | 是否存储 LLM 原始回复（审计用） |
| `failLogDir` | 无 | 失败日志目录（当前未接线） |
| `checkpointPath` | 无 | 自定义 checkpoint 路径；相对路径以 IMGDATA_DIR 为基准 |
| `checkpointEnabled` | `true` | 中断恢复 checkpoint 开关 |

`llm` 段（来自 `@llm-image/shared` 的 `createLlmConfigSchema`）：

- `provider`：可选，`openai` / `anthropic`。显式设置即使用；未设置时按环境
  变量中的 apiKey 自动选择（仅一方有 → 选该方；双方都有 → 报错；都没有 → 报错）。
- `[llm.openai]`：`apiBase` / `model`（缺省回退环境变量；环境变量显式设置时优先于配置文件）、`visionDetail`
  （默认 `high`，仅配置，无环境变量）。
- `[llm.anthropic]`：`model` / `apiBase`（缺省回退环境变量；环境变量显式设置时优先于配置文件）。
- 密钥（apiKey）一律只从环境变量读取，配置文件中的 apiKey 被静默忽略。

### 2.2 环境变量（`src/config/env.ts`）

| 变量 | 默认值 |
|---|---|
| `OPENAI_API_BASE` | `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | 无 |
| `OPENAI_MODEL` | `gpt-5.6-luna` |
| `ANTHROPIC_API_KEY` | 无 |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` |
| `ANTHROPIC_API_BASE` | 无 |
| `IMGDATA_DIR` | `~/.img-data`（`src/config/paths.ts` 默认家目录） |

## 3. Checkpoint 文件与缓存键

### 3.1 文件路径解析

优先级：CLI `--checkpoint` > 配置 `checkpointPath` > 默认
`<IMGDATA_DIR>/imgcleanup-checkpoint.json`。相对路径以 IMGDATA_DIR 为基准。

### 3.2 缓存键

- **裁决主键**：图片集合 = 排序后的 url 列表按换行拼接（`verdictKey`）。
- **图片集合指纹**：排序拼接后取 `sha256` 十六进制前 16 位（`imageSetHash`）。
- **裁判指纹（cacheKey）**：`sha256(provider | model | temperature | maxImageDimension | prompt-v<promptVersion>)`
  前 16 位。`temperature` 固定 0；`promptVersion` 为常量 `BATCH_PROMPT_VERSION =
  1`，修改 prompt 文本时手动递增以作废旧缓存。
- 只有 cacheKey 变化（裁判换了：provider / 模型 / maxImageDimension / prompt
  版本）才整体作废；`m`、目标目录、批次大小、分桶边界、路径过滤、图片集合
  增删不影响裁决复用。

### 3.3 落盘与生命周期

- 原子写：先写 `<name>.tmp` 再 `rename`（`saveCheckpoint`）；保存失败仅告警，
  降级为无恢复模式。
- 每完成一次比较即落盘（`Checkpoint.record`）；移动阶段每完成一个文件落盘
  （`appendMoveResult`，按源路径去重，`targetDir`/`dryRun` 变化时重置移动进度）。
- 信号处理：SIGINT / SIGTERM 先保存再退出（退出码 130）；kill -9 依赖每步即时落盘。
- 作废：`invalidateCheckpoint` 将旧文件备份为 `<path>.bak.<时间戳>` 后删除。
- 成功完成后 `markCompleted` 并删除 checkpoint 文件；dry-run 结束不标记完成，
  真实执行仍可复用全部裁决与移动进度。
- 校验：JSON 损坏 / schema 不匹配（`CheckpointDataSchema`）→ 视为不存在并重启。

## 4. 各阶段实现

### 4.1 分组（`src/grouping/`）

- `groupImages`：先按 standardName 分组，组内按 maxValue 升序排序，再按
  `bucketIndexFor`（边界数组二分语义：`[lo, hi)`，末桶 `[last, +∞)`）分桶；
  桶标签形如 `0-30`、`5000+`。
- `createBatches` / `needsLlm`：组内按 n 张一批；单张批次自动保留，不调用 LLM。

### 4.2 批次比较（`src/selection/batch-select.ts`、`src/llm/prompt.ts`）

- `buildBatchPrompt`：系统提示为「图片质量评审员」，按构图/清晰度/光影色彩/
  主题吸引力/技术参数五个维度选出最值得保留的 1 张；**不得包含任何估值信息**
  （估值高低、估值描述、置信度等）。
- 用户消息：当前时间、每张图的标签（A, B, C…）+ 文件名 + 技术元信息（格式、
  尺寸、通道数、文件大小 KB、损坏状态：不可解码像素占比）。图片以 base64 +
  `visionDetail` 传入。输出要求合法 JSON：`{"selected": "<标签>", "reason": "..."}`。
- 裁决先查 checkpoint（url 集合命中即跳过 LLM），否则调用 LLM 并记录。

### 4.3 锦标赛（`src/selection/tournament.ts`）

落选者 > m 时启动：两两配对（n=2）逐轮淘汰，每轮 LLM 选 1 张保留、另一张
进入下一轮，直到候选数 ≤ m；奇数轮次最后一张自动轮空保留。pair 裁决同样入
缓存；候选顺序由批次结果确定性推导，`m` 变化时已比较过的 pair 直接命中。

### 4.4 选择结果（`src/selection/engine.ts`）

- `parseM`：`50` → 绝对数量；`10%` → `ceil(total * pct / 100)`；百分比须在
  0~100 之间。
- 总数按「匹配过滤的图片数」（有 `--path`/`--standard` 时）或数据库去重文件
  数计算。
- 结果持久化 `toRemoveUrls` 到 checkpoint，供移动阶段恢复检测。

### 4.5 移动（`src/move/mover.ts`）

- `moveImages`：逐文件 rename 到目标目录；冲突模式 `skip`（跳过）/ `rename`
  （`name_1.ext`, `name_2.ext`…）/ `abort`（首个冲突即中止）。
- 每次移动后更新估值库 URL 记录（`updateRecordUrl`）与 file-index
  （作废旧 URL 记录、注册新 URL 的 blake3/size/status）。
- 「源已不在、目标已在」的半完成移动：补做数据库更新（视为 moved）。
- dry-run 只预览不移动；`targetDir`/`dryRun` 与 checkpoint 记录不一致时重置
  移动进度。

### 4.6 CLI 外壳（`src/cli/`）

- `commander` 定义命令 `cleanup`（默认子命令），程序名 `imgcleanup`，版本 0.1.0。
- 输出：`text`（表格 + 汇总，`--verbose`/`--dry-run` 时列明细）与 `json`
  两种格式（`src/cli/output/`）。
- 进度信息走 stderr `[debug]` / `[progress]` / `[checkpoint]` / `[interrupt]` 前缀。

## 5. 测试

- 单测覆盖：分组、批次、prompt、响应解析、引擎（含恢复）、checkpoint、
  checkpoint 解析（`tests/unit/`）。