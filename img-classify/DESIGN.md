# img-classify — 图片互斥分类器 设计文档

基于 LLM 的图片互斥分类 CLI 工具：给定图片与预定义**互斥类别集合**，调用多模态 LLM 将图片归入**唯一**类别并输出连续置信度；结果入库、按类别查询、按类别统计。

架构与约定严格对齐 `img-val`（commander CLI、`@llm-image/shared` 共享包、`@llm-image/file-index` 文件指纹、zod 校验、SQLite 迁移、TOML 配置、`~/.img-data` 统一数据目录）。与 `img-tagger`（多标签开放集 + 冲突解决）在语义与实现路径上解耦：本工具的类别空间是**封闭**的、类别集**互斥**、**一图一类**。

> 本文中标注 `**[假定 A<n>]**` 的段落是基于项目惯例做的最可能选项，尚未与用户确认。第 12 节汇总所有假定供逐条确认。

---

## 1. 目标与范围

### 1.1 功能范围

| 子命令 | 名称 | 是否调用 LLM |
|--------|------|--------------|
| `imgclassify <path\|dir>` | 图片分类（顶层默认命令） | 是（必须） |
| `imgclassify search <query>` | 按类别/置信度查询 | 否 |
| `imgclassify stats` | 类别分布统计 | 否 |
| `imgclassify standards list\|show <name>` | 分类标准管理 | 否 |
| `imgclassify images prune` | 清除未分类图片记录 | 否 |
| `imgclassify check` | 数据库健康检查（只读） | 否 |

**不做**（刻意的范围裁剪）：

- 不做多标签（一图一类）。多标签场景见 `img-tagger`。
- 不做标签/类别的开放集管理。类别由分类标准预定义，工具**不**让 LLM 新增类别。
- 不做文件移动。分类是只读元数据，文件位置由 file-index 管理。移动语义留待未来的 `img-sort` 或直接用 `img-cleanup` 处理。
- 不做聚类。**[已确认 A5]** 若未来需要"自动发现新类别"，另起工具（`img-cluster`），不复用本工具。

### 1.2 核心规则

- **一图一类**：每张已分类图片对应一个 `category` 值，必须精确匹配当前分类标准的 `categories` 之一。
- **类别互斥**：类别集由分类标准预定义，标准内不得有语义重叠的类别（这是标准编写者的责任，工具不做自动检测）；LLM 只从集合中选一。
- **强制输出类别标签**：LLM 必须输出 `category`（类别标签）。**[已确认 A4]** 输出为"直接内容"而非工具调用——类型标签由**约束解码**保证合法（OpenAI `response_format` 的 `category` 字段为 `enum = 标准类别列表`，生成期即受限；Anthropic 无原生 enum 约束，输出文本 JSON 后经程序校验兜底）。`rationale`（≤200 字中文）仅 `--rationale` 开启时输出，且**先输出原因、后输出类型标签**（§8.2）。置信度不要求 LLM 输出，由 provider 的 logprobs 派生（§8.4）。
- **不启用工具调用**。**[已确认 A3]**（随 A4 一并确立）——本工具不做任何工具调用循环，单次 prompt + 直接输出。这与 `img-val` 当前 Plan C（min/max 独立场景 + 结构化 response_format）在架构风格上更接近。
- **兜底由标准决定**：类别空间完全由分类标准的 `categories` 字段决定。**不存在工具级兜底值**——若标准作者需要兜底类别，可自行在类别列表中声明（如 `other`），工具不对其做特殊处理，与其它类别同等对待（正常入库、参与统计）。若 LLM 返回不在类别空间的类别名，视为解析失败（§8.3）并进入重试。
- **重分类语义**：跳过条件为 `image_hash + standard_hash` 均匹配——**换标准或改标准内容都会触发重分类**。见 §7.2。
- **置信度阈值由查询时动态指定**：**[已确认 A9]** 入库**不**固化任何阈值标志（无 `below_threshold` 字段、无 `min_confidence` 快照、无 `minConfidence` 配置）——每次查询/统计时的阈值可能不同，故由 `search`/`stats` 的 `min:`/`max:` 动态筛选（§4.3、§4.4）。
- **置信度来源**：完全来源于 provider 的 logprobs（§8.4）。**[已确认 A16]** Anthropic 路径不支持 logprobs，`confidence` 字段为 NULL；`search min:`/`max:` 阈值筛选忽略 NULL 记录。

### 1.3 术语表

| 术语 | 简略定义 |
|------|----------|
| **类别**（`category`） | 分类标准预定义的互斥类别之一，字符串标识 |
| **类别空间**（category space） | 一个分类标准的类别集（有序、去重） |
| **分类标准** | Markdown + YAML frontmatter，定义类别列表与类别描述 |
| **置信度**（`confidence`） | 由 provider logprobs 派生的 `0.0–1.0` 概率值；不支持 logprobs 时为 NULL |
| **`standard_hash`** | 分类标准 Markdown 全文 SHA-256，用于重分类判定与审计 |
| **logprobs 派生** | 从 `category` token 的 logprob 序列重建文本后取均值、`exp` 得概率的过程（§8.4） |

---

## 2. 与 img-val / shared / file-index 的复用关系

### 2.1 直接复用

- **`@llm-image/shared`**：
  - `processImage`（缩放与解码，取 `width`/`height`/`format`/`undecodablePixels`）
  - `hashBuffer`（SHA-256，用于 `standard_hash`）
  - `createProvider`（OpenAI / Anthropic）
  - `openSqlite`（自带迁移 runner，见 `shared/src/storage/sqlite.ts`）
  - 错误体系（`AppError` 及子类 `StandardError`、`ParseError`、`LLMError`、`ConfigError`）
  - `ResponseSchema` 类型
- **`@llm-image/file-index`**：
  - `blake3HexFile`（原始文件 BLAKE3 指纹）
  - `FileIndexRepo`（经 `blake3` 反查 `url`/`type`/`size`）
  - `toFileUrl` / `fileUrlToPath`

本工具 `classification` 表**只存** `blake3` 关联键，`url`/`format`/`size_bytes` 由 file-index 反查填充——避免与 file-index 双写不一致。与 `img-tagger` DESIGN 中的做法一致。

### 2.2 直接移植

从 `img-val` 移植（几乎不改）：

- `config/env.ts`、`config/paths.ts`（`IMGDATA_DIR` → `~/.img-data`；本工具落 `imgclassify.toml` + `imgclassify.db`）
- `standards/parser.ts`（gray-matter + zod，schema 见 §6.1）
- `standards/loader.ts`（内置标准 + 用户标准目录，用户覆盖内置）
- `llm/response-parser.ts` 的解析骨架（`tryParseJson` / code fence / trailing prose 提取）
- `llm/tool-flow.ts` 的**单次调用路径**（本工具仅用 `enableTools = false` 分支：OpenAI 带 `responseSchema` 走 `response_format` 约束解码；Anthropic 无 schema 约束走文本 JSON）
- `storage/db.ts`（openSqlite 单例）
- `util/url.ts`、`util/path-match.ts`、`util/fail-log.ts`（后者本工具会**收紧**：见 §5.3）
- `cli/output/{format,json,table,progress}.ts`

### 2.3 新增模块

- `classification/`：prompt 构建（`prompt.ts`）、响应校验（`response-parser.ts`）、引擎（`engine.ts`）、置信度处理（`confidence.ts`）
- `query/`：**简化查询语法**（不是 `img-tagger` 那种括号+反向+通配，仅 `category=X`、`min:0.8`、`max:0.9`、日期区间），见 §4.3
- `stats/`：类别分布统计（COUNT + 平均置信度）
- `fileindex.ts`：`FileIndexRepo` 单例与 url/type/size 反查（参照 img-search）
- `check.ts`：数据库健康检查（`schema_version`、`category` 与 `standard_hash` 一致性、file-index 命中漂移）

### 2.4 Provider 适配

沿用 `img-val` 现状：

- **OpenAI**：走 `response_format` 结构化输出（`strict: true`），**约束解码**——`category` 字段的 JSON schema 为 `enum: standard.categories`（运行时注入），模型生成期即被限制只能输出合法类别。**[已确认 A4]**
- **Anthropic**：**[已确认 A4]** 无原生 `response_format`/enum 约束解码——退化为**直接输出文本 JSON**，`category` 合法性由程序校验兜底（§8.3，配合 `classifyRetries` 重试）。两家 provider 均**不使用工具调用**；置信度仅从 OpenAI 路径的 logprobs 派生，Anthropic 路径下为 NULL（§8.4）。

**[已确认 A4 输出契约]**：LLM **直接输出内容**（非工具调用）。`--rationale` 控制输出结构：
- `--rationale=false`（默认）：仅输出 `category`（JSON：`{"category": "..."}`）；
- `--rationale=true`：输出 `{ "rationale", "category" }`，且 prompt 引导**先输出原因、后输出类型标签**（§8.2）。

与 `img-val`/`img-tagger` 明确区别：本工具完全不走 `submit_*` 工具提取、不在 shared provider 层扩展 `strict` 工具参数——输出路径只有"结构化约束解码（OpenAI）+ 文本 JSON 校验（Anthropic）"两种。

---

## 3. 目录结构与模块划分

```
img-classify/
├── package.json
├── tsconfig.json / tsconfig.build.json / vitest.config.ts
├── README.md
├── .env.example
├── adr/                              # 本工具专属 ADR（如需）
├── assets/
│   └── standards/
│       └── builtin/
│           └── default-general.md    # 内置默认分类标准（见 §6.2）
└── src/
    ├── index.ts                      # 入口，runCli(argv)
    ├── cli/
    │   ├── index.ts                  # commander 程序：命令注册
    │   ├── classify.ts               # 顶层默认命令（单图/目录批量）
    │   ├── search.ts                 # 按类别/置信度查询
    │   ├── stats.ts                  # 类别分布统计
    │   ├── standards.ts              # standards list/show
    │   ├── images.ts                 # images prune
    │   ├── check.ts                  # 数据库健康检查
    │   └── output/                   # json.ts / table.ts / progress.ts
    ├── config/
    │   ├── env.ts                    # bootstrap 环境变量（LLM provider + IMGDATA_DIR）
    │   ├── config.ts                 # imgclassify.toml 加载 + zod 校验
    │   └── paths.ts                  # 数据目录引导（默认 ~/.img-data）
    ├── standards/
    │   ├── parser.ts                 # 标准解析（frontmatter schema + body 类别块解析）
    │   ├── loader.ts                 # 内置/文件系统标准加载（用户覆盖内置）
    │   └── builtin/
    │       └── default-general.md    # 打包内置默认标准
    ├── classification/
    │   ├── prompt.ts                 # 构建 system + user prompt
    │   ├── tool-flow.ts              # 单次 LLM 调用（enableTools=false；OpenAI response_format / Anthropic 文本 JSON）
    │   ├── response-parser.ts        # 响应 JSON 解析与类别空间校验
    │   ├── engine.ts                 # 单图分类主流程（含重试、置信度计算）
    │   └── confidence.ts             # 从 logprobs 派生 confidence（重建 token 文本 + mean logprob + exp）
    ├── query/
    │   ├── parser.ts                 # 简化查询语法解析（key:value 前缀式）
    │   └── evaluate.ts               # 查询 → SQL WHERE
    ├── stats/
    │   └── stats.ts                  # 类别分布 SQL + 排序
    ├── fileindex.ts                  # file-index repo 单例 + 反查
    └── storage/
        ├── db.ts                     # openSqlite 单例 + 迁移
        ├── migrations/
        │   └── 001_init.sql          # classification 表 + 索引
        ├── types.ts
        └── repository/
            ├── classification.ts     # 单图 upsert / 批量 upsert / 反查
            ├── search.ts             # 按类别/置信度/日期查询
            └── prune.ts              # 清理未分类/漂移记录
```

---

## 4. CLI 命令

### 4.1 `imgclassify <path|dir>` — 单图/批量分类（顶层默认命令）

```
imgclassify <path>  [--standard <name|path>] [--format text|json] [--verbose]
imgclassify <dir>   [--standard <name|path>] [--recursive] [--concurrency N]
                    [--include <glob>] [--progress] [--mode <skip|full>]
                    [--dry-run] [--rationale]
```

选项说明：

| 选项 | 说明 |
|------|------|
| `--standard <name\|path>` | 分类标准；省略时默认 `default-general`（内置） |
| `--recursive` | 目录递归 |
| `--include <glob>` | 文件筛选（可重复） |
| `--concurrency N` | 并发数（默认 3） |
| `--progress` | 进度条 |
| `--mode <skip\|full>` | `skip`（默认）：`image_hash + standard_hash` 均匹配即跳过；`full`：全量重分类 |
| `--dry-run` | 只输出分类结果，不写库 |
| `--format <text\|json>` | 输出格式 |
| `--rationale` | 为 true 时 LLM 先输出原因（≤200 字中文）再输出类型标签；默认 false 只输出类型标签 |
| `--verbose` | 完整错误栈、EXIF、prompt 打印 |

输出 envelope 与 `img-val` 一致（`{ ok, data | error }`）；退出码沿用 `img-tagger` 设计（1 = LLM/校验、4 = 图片、5 = 存储）。

### 4.2 `imgclassify standards list|show <name>`

只读；不调 LLM。`list` 列出所有可用标准（内置 + 用户目录），`show <name>` 打印标准全文（frontmatter + body）。

### 4.3 `imgclassify search <query>`

简化查询语法（沿用 `img-val` 的 `key:value` 前缀式）：

```
imgclassify search [query] [--filter key=value...] [--limit N] [--format text|json]
```

支持的前缀：

| 前缀 | 语义 |
|------|------|
| `category:<name>` | 精确匹配类别（大小写敏感） |
| `category!:<name>` | 排除该类别 |
| `min:<0-1>` | 置信度 ≥ 阈值 |
| `max:<0-1>` | 置信度 ≤ 阈值 |
| `standard:<name>` | 匹配分类标准名称 |
| `from:<date>` / `to:<date>` | `classified_at` 区间 |

多条件 AND；无 query 且无 filter 时列出最近 N 条（默认 `--limit 50`）。

### 4.4 `imgclassify stats`

按类别分布统计：

```
imgclassify stats [--standard <name>] [--format text|json]
```

输出每类别的 `count`、`avg_confidence`、`min_confidence`、`max_confidence`；按 `count` 降序，同 count 时按类别名字节序稳定。`stats` 同样接受 `min:`/`max:` 动态阈值（经 `--filter` 传入），先过滤后聚合——阈值不落库、每次统计时可不同。**[已确认 A9]**

### 4.5 `imgclassify images prune`

删除 `classification` 表中 `rationale` 为空且 `category` 在对应标准中已不存在的记录（标准变更后的失效类别残留），以及 `image_hash` 在 file-index 已失联（BLAKE3 反查无结果且超过漂移阈值）的记录。默认 `--dry-run`，`--yes` 实际执行。

### 4.6 `imgclassify check`

五项检查：

1. `schema_version` 表存在且最新
2. 所有 `classification.category` 值在对应 `standard_hash` 版本的类别集合内（跨标准漂移检测）
3. `image_hash` 与 file-index 中的 BLAKE3 存在性（未命中 = 漂移）
4. 所有 `classification.rationale` 为 NULL 的记录与 `--rationale` 输出契约一致（仅在 `--rationale=false` 时产生）
5. `classified_at` 时区与 `standard_hash` 非空

只读；有异常时非零退出码；`--format json` 输出结构化报告。

---

## 5. 失败处理与日志

### 5.1 批处理语义
与 `img-tagger` 一致：单图失败不影响其它图；失败图分**分类失败**（LLM 错误、响应解析失败、`category` 不在类别空间内）与**单图前置校验失败**（文件缺失、解码失败、越界尺寸）。`--mode skip` 重跑跳过已分类成功的图。

### 5.2 重试策略

**[假定 A6 待确认]** 单图内**最多 2 次重试**（`classifyRetries`，默认 2），仅对**响应解析失败**重试——`category` 缺失/非法/不在类别空间内、JSON 解析失败，以及 `--rationale=true` 时 `rationale` 缺失；LLM API 错误按 shared provider 内置重试（通常 3 次）；文件级错误不重试。每次重试在原 prompt 后追加一条用户消息：`"上一次响应无效：<错误原因>，请重新返回合法 JSON。"`。

### 5.3 failLogDir

与 `img-tagger` 一致地**收紧隐私**：

- 默认**禁用**（`failLogDir = ""`）
- 启用时**图片块一律替换为 `[图片内容省略]`**——不做 base64 入日志
- **不**默认记录 EXIF；`failLogIncludeExif = true` 才记录
- 只记录 LLM 分类流程失败；`search`/`stats`/`images prune`/`check` 等非 LLM 操作不写日志

---

## 6. 分类标准

### 6.1 Frontmatter schema（`standards/parser.ts`）

```ts
const frontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().optional(),
  /** 允许的类别 ID 列表；顺序即标准定义顺序，同时用于 prompt 中的枚举顺序 */
  categories: z.array(z.string()).min(1),
  /** 允许的图像格式提示（仅作 prompt 提示，不强制过滤） */
  image_formats: z.array(z.string()).optional(),
  /** 全局规则文本（追加到 body 之前） */
  notes: z.string().optional(),
});
```

**[假定 A1]** 类别**只**在 frontmatter `categories` 中列出，body 是**类别描述**（每个类别一小节）；`parser.ts` 会校验 body 是否覆盖所有 frontmatter 类别，缺失则报错——防止类别名漂移。

### 6.2 内置默认标准 `default-general`

```markdown
---
name: default-general
description: 通用图片分类——按内容题材划分
version: "1.0.0"
categories:
  - photo-portrait        # 人像
  - photo-scene           # 场景/风景
  - photo-animal          # 动物
  - photo-food            # 美食
  - photo-document        # 文档/截图
  - photo-product         # 商品/物品特写
  - photo-artwork         # 艺术创作（画作、插画、设计稿）
  - image-screenshot      # 屏幕截图
  - image-drawing         # 手写/简笔画/草图
  - graphic               # 图形/图表/logo
  - animation             # 动画帧/动图截帧
  - other                 # 未列入上述类别的图片
image_formats: [jpeg, png, webp, gif]
---

# 通用图片分类标准

## 分类原则

- 类别互斥，一张图片只归入一类；若同时具备多类特征，选择**主体**所属的类别。
- 优先选择具体类别（如 `photo-animal`），仅当无法归属具体类时回退 `other`。
- 判断依据以图像主体为主，构图与拍摄环境次之。

## 类别描述

### photo-portrait（人像）
含人类为主体（单人或人群），人脸清晰可辨。
包含：证件照、日常人像、群像、自拍。
排除：以人物为背景的场景（应归 `photo-scene`）。

### photo-scene（场景/风景）
自然/城市景观、建筑外景、道路、天文、天气等无明确单一主体的场景。
排除：以人物为主体且背景是场景（应归 `photo-portrait`）。

### photo-animal（动物）
以真实动物为主体的自然或饲养场景。
排除：动物的绘画/卡通形象（应归 `photo-artwork` 或 `graphic`）。

### photo-food（美食）
以食物、饮品为主体，且非艺术/设计稿（艺术稿归 `photo-artwork`）。

### photo-document（文档/截图）
纸质文档的照片（书页、笔记、合同扫描件），非屏幕截图。
排除：屏幕截图（应归 `image-screenshot`）。

### photo-product（商品/物品特写）
以商品、物品为主体，突出其形状、材质、用途。
排除：人物手持商品为主画面（应归 `photo-portrait`）。

### photo-artwork（艺术创作）
绘画、插画、板绘、素描、水彩、摄影艺术创作（有明确创作意图且风格化）。
排除：真实照片（即使构图美）。

### image-screenshot（屏幕截图）
软件 UI、网页、游戏画面的截图。
包含：带系统状态栏的手机截图、桌面窗口截图。

### image-drawing（手写/简笔画/草图）
手写文字、简笔画、草图；不含正式艺术作品（归 `photo-artwork`）。

### graphic（图形/图表/logo）
logo、图表、流程图、示意图、纯图形元素。

### animation（动画帧）
动画电影/短片/动图的单帧截图；含明显动画风格或字幕轨。

### other（其它）
上述类别均不适用的兜底类别。
包含：损坏严重的图片、无法辨识内容的抽象纹理、非典型内容。

## 输出约束

- `category` 必须精确匹配上述类别名（大小写敏感）
- `rationale`（若 `--rationale` 开启）不超过 200 字中文，须指明判断依据，且先于类别输出
- 若图片无法归入任何明确类别，返回 `category: "other"`（`rationale` 开启时在其中说明原因）
```

### 6.3 用户自定义标准

用户把 Markdown 文件放入 `~/.img-data/classify-standards/*.md`（或配置项 `standardsDir` 指向的目录）即可。同名 `name` 时用户文件覆盖内置文件（与 `img-val` 一致）。

---

## 7. 存储设计

### 7.1 Schema（`storage/migrations/001_init.sql`）

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classification (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  image_hash        TEXT    NOT NULL,           -- 处理后内容 SHA-256
  blake3            TEXT    NOT NULL,           -- 原始文件 BLAKE3（file-index 关联键）
  standard_name     TEXT    NOT NULL,
  standard_version  TEXT,
  standard_hash     TEXT    NOT NULL,           -- 标准全文 SHA-256（重分类判定用）
  category          TEXT    NOT NULL,           -- 类别名（严格来自 standard.frontmatter.categories）
  confidence        REAL,                       -- 由 logprobs 派生；不支持 logprobs 时 NULL
  rationale         TEXT,                        -- --rationale=false 时为 NULL；为 true 时存 ≤200 字原因
  llm_model         TEXT    NOT NULL,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  classified_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_class_hash        ON classification(image_hash);
CREATE INDEX IF NOT EXISTS idx_class_standard    ON classification(standard_hash);
CREATE INDEX IF NOT EXISTS idx_class_category    ON classification(category);
CREATE INDEX IF NOT EXISTS idx_class_confidence  ON classification(confidence);
CREATE INDEX IF NOT EXISTS idx_class_at          ON classification(classified_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_class_hash_standard
  ON classification(image_hash, standard_hash);
```

**[已确认 A7]** `uq_class_hash_standard` 唯一索引：同一图片 + 同一标准版本只保留一行。`--mode full` 显式覆盖时先 `DELETE WHERE image_hash = ? AND standard_hash = ?` 再插入，保持单行不变式——避免"同一标准多次分类"造成历史膨胀。历史分类如需审计，通过 failLogDir 而非本表。

### 7.2 重分类与去重

`--mode skip`（默认）判定：`SELECT 1 FROM classification WHERE image_hash = ? AND standard_hash = ?`——两者均命中则跳过。因此：

- 同一图片 + 同一标准 → 跳过（幂等）
- 同一图片 + 换标准（不同 `standard_name`）→ 重新分类，新标准 hash 与旧不同
- 同一图片 + 改标准内容（`standard_hash` 变） → 重新分类
- 同一图片 + 换 provider/model → 不跳过，重新分类（模型输出可能不同）

`--mode full` 强制重新分类（覆盖已有记录）。

### 7.3 file-index 集成

- 分类前：`blake3HexFile(path)` 计算原始文件 BLAKE3；`FileIndexRepo.findByBlake3(blake3)` 反查 `url`/`type`/`size`
- 分类成功后：若 file-index 未登记，`register({ blake3, url: toFileUrl(path), type, size })`
- `classification` 表只存 `blake3` 关联键；`search`/`stats` 输出时经 file-index 反查填充 `path`/`format`/`size_bytes`

---

## 8. LLM 分类流程

### 8.1 输入组装

1. `blake3HexFile(path)` → 原始 BLAKE3
2. `processImage({ path, maxImageDimension })` → `{ base64, width, height, format, undecodablePixels }`（缩放至最长边 `maxImageDimension`，默认 1568）
3. `SHA-256(processed content)` → `image_hash`
4. 加载分类标准 → `{ frontmatter, body, contentHash }`
5. 若 `image.undecodablePixels > 0`：在 user prompt 中追加"损坏状态：X% 像素不可解码"

### 8.2 Prompt 构建（`classification/prompt.ts`）

**System prompt**（示意）：

你的任务是根据《分类标准》对给定的图片分类，输出唯一类别。

严格遵守以下规则：
{--rationale=true 时追加：}
0. 请先给出判断原因（不超过 200 字中文），再给出类型标签。
{--rationale=false 时：}
1. 输出必须是合法 JSON，仅包含一个字段（不添加任何其他内容）：
   {"category": "<类别名>"}
{--rationale=true 时：}
1. 输出必须是合法 JSON，仅包含两个字段（不添加任何其他内容）：
   {"rationale": "<≤200 字中文原因>", "category": "<类别名>"}
2. `category` 必须精确匹配《分类标准》中的类别之一（大小写敏感）；不得新增、拼接、翻译或改写。
3. 若图片难以清晰归入任何明确类别，优先选择最接近的类别；`rationale`（若开启）中说明为何该类别最接近。
4. 严禁输出 category 与 rationale（若开启）之外的字段。

《分类标准》
名称: {name}
描述: {description}
版本: {version}

{body}

**User message**：

```
当前时间: {ISO-8601}
图片 URL: {file-url}
图片格式: {format}
尺寸: {width}x{height}
{损坏状态: ...}
请基于上述图片与《分类标准》输出分类 JSON。
```

（附带 `image_url` 图片块）

### 8.3 响应解析（`classification/response-parser.ts`）

**JSON Schema**（OpenAI `response_format` 约束解码用；`category` 字段为 enum，运行时注入 `standard.categories`。Anthropic 无原生约束解码，退化为 prompt 引导 + 文本 JSON 校验）：
```ts
export function classificationSchema(rationale: boolean): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      category: { type: 'string', enum: standardCategories, description: '分类标准中定义的类别名，大小写敏感' },
      ...(rationale ? { rationale: { type: 'string', description: '不超过 200 字的中文说明' } } : {}),
    },
    required: rationale ? ['category', 'rationale'] : ['category'],
    additionalProperties: false,
  };
}
```

**校验步骤**（`validateClassificationResponse`）：

1. JSON 解析（三路径：直接、code fence、trailing prose）
2. zod schema 校验（字段、类型、`additionalProperties: false`；`category` 必须为字符串且非空）
3. **类别空间校验**：`category` 必须严格属于 `standard.frontmatter.categories`——大小写敏感；不在集合内视为**解析失败**（计入重试）。不存在工具级兜底值：若标准作者希望有兜底类别，需在标准 `categories` 中显式声明（如 `other`）。
4. **`--rationale` 一致性**：`--rationale=true` 时 `rationale` 字段必须存在且非空；`--rationale=false` 时若响应包含 `rationale` 字段则忽略之（不报错）。

### 8.4 置信度（`classification/confidence.ts`）

**[已确认 A8]** `confidence` 完全来源于 provider 的 logprobs——LLM **不**输出置信度字段。

**派生方式**（参考 `img-val/src/llm/response-parser.ts` 的 `meanLogprobForValue` 实现）：

1. 请求时向 provider 传 `logprobs: true, top_logprobs: 5`（OpenAI；Anthropic 不支持）
2. 从 `logprobs.tokens` 序列重建完整文本与每个 token 的字符区间
3. 用正则定位 `"category"` key 对应的字符串值（如 `"photo-portrait"`）的字符区间
4. 对该区间内所有重叠 token 的 `logprob` 求平均
5. `exp(mean_logprob)` 得到 0–1 概率作为 `confidence`

**Anthropic provider 不支持 logprobs**：**[已确认 A16]**
- 请求为普通文本 JSON，不带 logprob 信息
- `confidence` 字段为 NULL；`stats` 的 `avg_confidence` 计算忽略 NULL
- `search --min`/`--max` 阈值筛选时忽略 NULL 记录（不匹配）
**跨 provider 一致性**：同一张图片在 OpenAI 与 Anthropic 下 `confidence` 不可直接比较（前者有值、后者 NULL）。审计与校准建议只用 OpenAI 路径；跨 provider 场景仅比较 `category` 与 `rationale`。

**`enableLogprobs = false` 时**：不请求 logprobs，`confidence` 全为 NULL，阈值筛选对 `min:`/`max:` 形同虚设（NULL 不匹配）。这是配置层的选择，CLI 不提供覆盖开关（**[已确认 A15]**）。**[已确认 A17]** 此时工具照常工作，不受影响。

### 8.5 写入流程

```
1. 前置校验：文件存在、可解码、尺寸在范围
2. 检查 `--mode skip` 命中（`image_hash + standard_hash`）→ 跳过
3. 组装 prompt → `runToolFlow`（`enableTools=false`，`responseFormat=classificationSchema(rationale)`（OpenAI）或文本 JSON（Anthropic），`logprobs=enableLogprobs`）
4. 解析响应 → 校验类别空间；若 `category` 不在集合内视为解析失败（重试，最多 `classifyRetries` 次）
5. 从 logprobs 派生 `confidence`（若 provider 不支持或 `enableLogprobs=false` 则 NULL）
6.（无阈值判定——不入库任何阈值标志，**[已确认 A9]**）
7. `DELETE WHERE image_hash = ? AND standard_hash = ?`（uq 冲突时先删）
8. `INSERT classification`（含 `standard_hash`、`rationale`（`--rationale=false` 时为 NULL）；`confidence` 可能为 NULL）
9. `register file-index`（若未登记）
```

**[已确认 A9]** 一律入库：无论置信度高低、是否带 rationale，只要响应通过校验就写库。阈值筛选完全由用户**查询时**通过 `search`/`stats` 的 `min:`/`max:` 动态指定（§4.3、§4.4）——每次不同均可，不依赖任何落库标志。

---

## 9. 配置与数据

### 9.1 环境变量

与 `img-val` 一致：

| 变量 | 说明 |
|------|------|
| `OPENAI_API_BASE` / `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI 兼容配置 |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` / `ANTHROPIC_API_BASE` | Anthropic 配置 |
| `IMGDATA_DIR` | 统一数据目录（默认 `~/.img-data`） |

**配置为唯一来源**（不提供同名环境变量覆盖，除 LLM provider 段的 `apiBase`/`apiKey`/`model` 回退外）。

### 9.2 配置文件 `imgclassify.toml`

路径：`<IMGDATA_DIR>/imgclassify.toml`。

```toml
[llm]
provider = "openai"

[llm.openai]
apiBase = "https://api.openai.com/v1"
apiKey = "sk-..."
model = "gpt-4o"
visionDetail = "high"

[llm.anthropic]
apiKey = "sk-ant-..."
model = "claude-sonnet-5"
apiBase = ""

standardsDir = "~/.img-data/classify-standards"
maxImageDimension = 1568
rationale = false
classifyRetries = 2
enableLogprobs = true
failLogDir = ""
failLogIncludeExif = false
```

### 9.3 字段说明

| 配置项 | 类型 / 默认 | 说明 |
|--------|-------------|------|
| `standardsDir` | string, `~/.img-data/classify-standards` | 分类标准目录 |
| `maxImageDimension` | int, `1568` | 送 LLM 前最长边限制 |
| `rationale` | bool, `false` | 分类时 LLM 是否输出原因（先原因后类别）；仅控制输出，不落库固化阈值 |
| `classifyRetries` | int, `2` | 单图内 LLM 响应解析失败重试次数 |
| `enableLogprobs` | bool, `true` | 是否请求 provider 返回 logprobs（`confidence` 唯一来源；`false` 时 confidence 全为 NULL） |
| `failLogDir` | string, `""` | 失败日志目录；空串禁用 |
| `failLogIncludeExif` | bool, `false` | 失败日志是否记录 EXIF（含 GPS） |

---

## 10. 测试计划

- **standards/**：frontmatter 解析（合法/非法类别、空列表、缺 name）、body 类别覆盖校验（frontmatter 与 body 不一致时报错）、加载优先级（用户覆盖内置）、`contentHash` 稳定性
- **classification/prompt.ts**：system prompt 结构（`--rationale=false` 单字段输出 / `--rationale=true` 先原因后类别两字段输出）、user prompt 组装（含/不含 EXIF、含/不含 undecodable、损坏状态行）
- **classification/response-parser.ts**：三路径 JSON 提取、zod 校验（`category` 枚举合法性）、类别空间校验（大小写、非法类别、frontmatter 内声明的兜底类别如 `other` 与真实类别同等对待）、`--rationale` 一致性（true 时缺 rationale 报错 / false 时多余 rationale 忽略）
- **classification/engine.ts**：`--mode skip` 命中/未命中（`image_hash`/`standard_hash` 各自变化）、`--rationale` 传递到 prompt 与 schema、`--dry-run` 无副作用、单图失败隔离、写入无阈值标志（`rationale=NULL` 仅由 `--rationale=false` 产生）
- **classification/confidence.ts**：logprobs 派生（OpenAI 返回、不返回、`enableLogprobs=false`、token 未覆盖 category 值 → 均返回 NULL）、Anthropic 路径下字段 NULL、`exp(mean_logprob)` 数值稳定性（极小 logprob 不产出 NaN/0）
- **query/**：语法解析（`key:value`、组合条件、非法前缀）、SQL 生成（大小写敏感、`category`/`min`/`max`/`standard`/日期区间）
- **stats/**：COUNT 与 `AVG(confidence)`、`min`/`max` 动态过滤后聚合、标准过滤
- **storage/**：迁移 runner、uq 冲突删除路径、`images prune` 命中漂移记录、只读模式
- **check/**：五项检查各自命中/未命中、只读、`--format json` 结构、非零退出码
- **concurrency/**：`--concurrency N` 下不同 `image_hash` 并行、相同 `image_hash` 不并发（per-hash 串行）、批量下无 `SQLITE_BUSY`（WAL + busy_timeout）
- **fail-log/**：图片块替换为占位符、默认不记录 EXIF、`failLogIncludeExif = true` 记录、非 LLM 操作不写入、`--dry-run` 不写入
- **端到端冒烟**：fixtures 图片分类 → `search category=...` → `stats` → `images prune` → `check`

---

## 11. 与 img-tagger / img-val 的边界

| 维度 | img-val | img-classify | img-tagger |
|------|---------|--------------|------------|
| 输出结构 | `{ min, max, rationale }` | `{ category, rationale? }` + logprobs 派生 confidence | `tags: string[]` |
| 输出空间 | 数值区间 | 封闭类别集（无工具级兜底） | 开放标签集 |
| 一图多值 | 是（两个数） | 否（1 类别） | 是（多标签） |
| LLM 工具调用 | 有（`submit_valuation`、`get_exif`、`search_valuations`） | **无** | 有（`create_tag`、`modify_image_tags`、`submit_tags`、`get_exif`） |
| 冲突解决 | 无 | 无（类别空间封闭、一图一类，不可能冲突） | 有（标签串冲突 → LLM 自动解决） |
| 类别/标签来源 | 数值无此概念 | 预定义于标准 | 开放（LLM 可新建） |
| 数据模型 | `valuation` 表 + FTS | `classification` 表 + 索引 | `image` + `tag` + `image_tag` 三表 |
| CLI 二进制 | `imgval` | `imgclassify` | `imgtagger` |
| 配置文件 | `imgval.toml` | `imgclassify.toml` | `imgtagger.toml` |
| 数据库 | `imgval.db` | `imgclassify.db` | `imgtagger.db` |
| 共用文件索引 | 是 | 是 | 是 |

`img-classify` 与 `img-tagger` 完全解耦：不同数据库、不同数据模型、不同 LLM 交互风格。用户可以同时使用两者——用 `img-classify` 做粗粒度分类，用 `img-tagger` 做细粒度打标，两者通过 file-index 的 `blake3` 关联但不共享存储。

---

## 12. 假定清单

### 12.1 已确认

| 编号 | 位置 | 已确认内容 |
|------|------|-----------|
| **A2** | §1.2 / §8.3 | 取消工具级兜底值：LLM 返回的 `category` 必须严格属于 `standard.frontmatter.categories`；兜底类别由标准作者自行在 `categories` 中声明（如 `other`），工具不做特殊处理 |
| **A3** | §1.2 / §8 | 不启用工具调用（随 A4 一并确立）——单次 prompt + 直接输出，无任何工具循环 |
| **A4** | §2.4 / §8.2 / §8.3 | 直接输出内容（非工具调用）；类型标签由约束解码得到（OpenAI `response_format` enum；Anthropic 文本 JSON + 程序校验）；新增 `--rationale`（默认 false）：true 时先输出原因再输出类型标签，false 时仅输出类型标签 |
| **A5** | §1.1 | 不做聚类，"自动发现新类别"另起工具（`img-cluster`） |
| **A7** | §7.1 / §7.2 | `uq_class_hash_standard` 唯一索引，同一图片+同一标准只保留一行；`--mode full` 先删后插 |
| **A8** | §8.4 | `confidence` 完全来源于 provider 的 logprobs 派生；LLM 不输出置信度字段 |
| **A9** | §1.2 / §7.1 / §8.5 | 删除 `below_threshold` 字段与 `min_confidence` 快照/配置：入库不固化任何阈值标志，阈值完全由查询/统计时 `min:`/`max:` 动态指定（每次可不同） |
| **A11** | §4.1 | 顶层默认命令是分类；`search`/`stats`/`standards`/`images`/`check` 为子命令 |
| **A13** | §4.5 | 保留 `images prune`（清理失效类别/漂移记录） |
| **A15** | §4.1 / §9.3 | `enableLogprobs` 仅由配置文件控制，无 CLI 开关 |
| **A16** | §8.4 | Anthropic 无 logprobs 时 `confidence` = NULL；`stats.avg_confidence` 忽略 NULL；`search min:`/`max:` 忽略 NULL 记录 |
| **A17** | §8.4 | `enableLogprobs = false` 时 `confidence` 全为 NULL、阈值筛选对 `min:`/`max:` 形同虚设；工具照常工作 |

### 12.2 待确认

以下为基于项目惯例做的最可能选项。**请逐条确认是否需要调整**。

| 编号 | 位置 | 假定 | 备选方案 |
|------|------|------|----------|
| **A1** | §6.1 / §6.2 | 类别在 frontmatter `categories` 数组列出，body 是每类别一节描述；`parser` 校验 body 覆盖 | body 直接内联类别列表（frontmatter 只放 name/description/version），或 frontmatter + body 混合（frontmatter 只列类别名，body 里每个类别用固定小节格式） |
| **A6** | §5.2 | 单图内 2 次重试仅对响应解析失败 | 也重试 LLM API 错误（超出 shared provider 内置重试）；或增加到 3 次 |
| **A10** | §4.3 | 查询语法沿用 img-val 的 `key:value` 前缀式 | 支持 `img-tagger` 式括号/反向/通配查询（复杂度较高，与"简化"目标冲突） |
| **A12** | §6.2 | 内置默认标准 `default-general` 有 12 个类别（含 `other`） | 更粗粒度（5–6 类）；或更细粒度（20+ 类）；或纯"人物/场景/物品/文档"4 类 |
| **A14** | §5.1 / §4.1 | 支持 `--mode skip\|full`；不支持 `sync`（img-val 有 `sync` 用于路径漂移修复） | 增加 `sync` 模式（file-index 反查后同步路径，但 `classification` 表不存 `url`，实际无意义——保留但不实现） |

---

## 13. 后续实施顺序（建议）

1. **骨架**：`package.json`、`tsconfig*`、`vitest.config.ts`、`src/index.ts`、`cli/index.ts`（commander 命令注册）；`config/*`（env / config / paths）
2. **共享层集成**：`storage/db.ts`、`storage/migrations/001_init.sql`、`fileindex.ts`
3. **标准系统**：`standards/parser.ts`、`standards/loader.ts`、`assets/standards/builtin/default-general.md`
4. **分类引擎**：`classification/prompt.ts`、`response-parser.ts`、`engine.ts`、`confidence.ts`
5. **CLI 主路径**：`cli/classify.ts`（单图 + 批量）
6. **CLI 副路径**：`cli/search.ts`、`cli/stats.ts`、`cli/standards.ts`、`cli/images.ts`、`cli/check.ts`
7. **测试**：按 §10 逐项补齐
8. **README + ADR**（如有决策分歧）

以上顺序假设用户确认后无重大调整。若某假定被推翻，可能触发对应步骤的返工。
