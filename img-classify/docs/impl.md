# img-classify 实现文档

> 最后更新：2026-09-09

本文档描述 `img-classify` 的实现细节：模块划分、内部 API、SQL schema、配置键名与默认值、CLI 命令的完整选项与退出码、prompt 结构、重试细节、测试计划等。

## 1. 目录结构与模块划分

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
│           └── default-general.md    # 内置默认分类标准；唯一真源（加载以 assets/ 为准，见 §3.5）
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
    │   └── output/                   # format.ts / json.ts / table.ts / progress.ts
    ├── config/
    │   ├── env.ts                    # bootstrap 环境变量（LLM provider + IMGDATA_DIR）
    │   ├── config.ts                 # imgclassify.toml 加载 + zod 校验
    │   └── paths.ts                  # 数据目录引导（默认 ~/.img-data）
    ├── standards/
    │   ├── parser.ts                 # 标准解析（frontmatter schema + body 类别块解析）
    │   ├── loader.ts                 # 内置/文件系统标准加载（用户覆盖内置）
    │   └── builtin/
│       └── default-general.md    # 构建期拷贝，勿直接编辑（真源见 assets/）
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
    ├── util/
    │   ├── url.ts                      # 路径 → file URL
    │   ├── path-match.ts               # glob 匹配
    │   └── fail-log.ts                 # 失败日志（见 §6.3）
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

> `@llm-image/shared`、`@llm-image/file-index` 等共享包与 `img-val` 同仓库（`packages/` 或等效位置），本工具以依赖方式引用。

## 2. 从 img-val 移植的模块

以下模块从 `img-val` 移植（几乎不改）：

| 移植来源 | 目标 | 说明 |
|----------|------|------|
| `config/env.ts`、`config/paths.ts` | `config/env.ts`、`config/paths.ts` | `IMGDATA_DIR` → `~/.img-data`；本工具落 `imgclassify.toml` + `imgclassify.db` |
| `standards/parser.ts` | `standards/parser.ts` | gray-matter + zod，schema 见 §3.1 |
| `standards/loader.ts` | `standards/loader.ts` | 内置标准 + 用户标准目录，用户覆盖内置 |
| `llm/response-parser.ts` | `classification/response-parser.ts` | 解析骨架（`tryParseJson` / code fence / trailing prose 提取） |
| `llm/tool-flow.ts` | `classification/tool-flow.ts` | **单次调用路径**（本工具仅用 `enableTools = false` 分支：OpenAI 带 `responseSchema` 走 `response_format` 约束解码；Anthropic 无 schema 约束走文本 JSON） |
| `storage/db.ts` | `storage/db.ts` | openSqlite 单例 |
| `util/url.ts`、`util/path-match.ts`、`util/fail-log.ts` | 同路径 | `util/fail-log.ts` 本工具会**收紧隐私**：见 §6.3 |
| `cli/output/{format,json,table,progress}.ts` | 同路径 | CLI 输出格式化 |

## 3. 分类标准系统

### 3.1 Frontmatter Schema（`standards/parser.ts`）

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

类别**只**在 frontmatter `categories` 中列出，body 是**类别描述**（每个类别一小节）；`parser.ts` 会校验 body 是否覆盖所有 frontmatter 类别，缺失则报错——防止类别名漂移。

### 3.2 内置默认标准 `default-general`

> 以下为 `assets/standards/builtin/default-general.md` 真源的全文内嵌；修改标准请改真源文件并同步此处（`src/standards/builtin/` 为构建期拷贝，勿直接编辑）。

```markdown
name: default-general
description: 通用图片分类——按内容题材划分
version: "1.0.0"
categories:
  - photo-portrait        # 人像
  - photo-scene           # 场景/风景
  - photo-animal          # 动物
  - photo-food            # 美食
  - photo-document        # 文档照
  - photo-product         # 商品/物品特写
  - photo-artwork         # 艺术创作（画作、插画、设计稿）
  - image-screenshot      # 屏幕截图
  - image-drawing         # 手写/简笔画/草图
  - graphic               # 图形/图表/logo
  - animation             # 动画帧/动图截帧
  - other                 # 未列入上述类别的图片
image_formats: [jpeg, png, webp, gif]
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

### photo-document（文档照）
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
- 若图片无法归入任何具体类别且本标准含 `other`，返回 `category: "other"`（`rationale` 开启时在其中说明原因）
```

### 3.3 用户自定义标准

用户把 Markdown 文件放入 `~/.img-data/classify-standards/*.md`（或配置项 `standardsDir` 指向的目录）即可。同名 `name` 时用户文件覆盖内置文件（与 `img-val` 一致）。

### 3.4 标准解析实现（`standards/parser.ts`）

- 使用 gray-matter 解析 Markdown frontmatter
- zod schema 校验 frontmatter 字段
- body 解析：提取每个 `### <类别名>` 小节的描述内容
- 校验 body 覆盖 frontmatter 类别，缺失则报错

### 3.5 标准加载（`standards/loader.ts`）

- 内置标准：从 `assets/standards/builtin/` 加载（`src/standards/builtin/` 为打包内置副本，加载以 `assets/standards/builtin/` 为准）
- 用户标准路径与覆盖优先级见 §3.3
- 计算 `standard_hash`（标准全文 SHA-256）用于重分类判定

## 4. 存储设计

库文件默认路径：`<IMGDATA_DIR>/imgclassify.db`（与 `imgclassify.toml` 同目录）。

### 4.1 Schema（`storage/migrations/001_init.sql`）

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
  rationale         TEXT,                        -- 未传 --rationale 时为 NULL；传 --rationale 时存 ≤200 字原因
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

`uq_class_hash_standard` 唯一索引：同一图片 + 同一标准**内容**（standard_hash）只保留一行。`--mode full` 显式覆盖时先 `DELETE WHERE image_hash = ? AND standard_hash = ?` 再插入，保持单行不变式——避免"同一标准多次分类"造成历史膨胀。失败记录如需审计，经 failLogDir。

### 4.2 重分类与去重

`--mode skip`（默认）判定：`SELECT 1 FROM classification WHERE image_hash = ? AND standard_hash = ?`——两者均命中则跳过。因此：

- 同一图片 + 同一标准 → 跳过（幂等）
- 同一图片 + 图片内容被修改（`image_hash` 变）→ 重新分类
- 同一图片 + 换标准（不同 `standard_name`）→ 重新分类，新标准 hash 与旧不同
- 同一图片 + 改标准内容（`standard_hash` 变） → 重新分类
- 同一图片 + 换 provider/model → 命中 skip 跳过（去重键不含模型；如需重分请用 `--mode full`）


### 4.3 file-index 集成

- 分类前：`blake3HexFile(path)` 计算原始文件 BLAKE3；`FileIndexRepo.findByBlake3(blake3)` 反查 `url`/`type`/`size`
- 分类成功后：若 file-index 未登记，`register({ blake3, url: toFileUrl(path), type, size })`
- `classification` 表只存 `blake3` 关联键；`search`/`stats` 输出时经 file-index 反查填充 `path`/`format`/`size_bytes`

## 5. LLM 分类流程实现

### 5.1 输入组装

1. `blake3HexFile(path)` → 原始 BLAKE3
2. `processImage({ path, maxImageDimension })` → `{ base64, width, height, format, undecodablePixels }`（缩放至最长边 `maxImageDimension`，默认 1568）
3. `SHA-256(processed content)` → `image_hash`
4. 加载分类标准 → `{ frontmatter, body, standard_hash }`
5. 若 `image.undecodablePixels > 0`：在 user prompt 中追加"损坏状态：X% 像素不可解码"

### 5.2 Prompt 构建（`classification/prompt.ts`）

**System prompt**（示意）：

```
你的任务是根据《分类标准》对给定的图片分类，输出唯一类别。

严格遵守以下规则：
{未传 --rationale 时：}
1. 输出必须是合法 JSON，仅包含一个字段（不添加任何其他内容）：
   {"category": "<类别名>"}
2. `category` 必须精确匹配《分类标准》中的类别之一（大小写敏感）；不得新增、拼接、翻译或改写。
3. 若图片难以归入任何具体类别：标准含 `other` 时返回 `other`；标准不含 `other` 时如实报告无法归类（输出清单外内容或空，触发校验失败重试），不要强行选择清单内类别。
4. 严禁输出 category 之外的字段。
{传 --rationale 时：}
1. 请先给出判断原因（不超过 200 字中文），再给出类别。
2. 输出必须是合法 JSON，仅包含两个字段（不添加任何其他内容）：
   {"rationale": "<≤200 字中文原因>", "category": "<类别名>"}
3. `category` 必须精确匹配《分类标准》中的类别之一（大小写敏感）；不得新增、拼接、翻译或改写。
4. 若图片难以归入任何具体类别：标准含 `other` 时返回 `other`（`rationale` 中说明原因）；标准不含 `other` 时如实报告无法归类并在 `rationale` 中说明，不要强行选择清单内类别。
5. 严禁输出 category 与 rationale 之外的字段。

《分类标准》
名称: {name}
描述: {description}
版本: {version}

{body}
```

**User message**：

```
当前时间: {ISO-8601}
图片 URL: {file-url}
图片格式: {format}
尺寸: {width}x{height}
{损坏状态: ...}
{promptIncludeExif=true 时追加：EXIF 摘要（被剥离 GPS 后）}
请基于上述图片与《分类标准》输出分类 JSON。
```

（附带 `image_url` 图片块）

### 5.3 响应解析（`classification/response-parser.ts`）

**JSON Schema**（OpenAI `response_format` 约束解码用；`category` 字段为 enum，`standardCategories` 为运行时注入的 `standard.frontmatter.categories`。Anthropic 无原生约束解码，退化为 prompt 引导 + 文本 JSON 校验）：

```ts
export function classificationSchema(rationale: boolean, standardCategories: string[]): Record<string, unknown> {
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
4. **`--rationale` 一致性**：传 `--rationale` 时 `rationale` 字段必须存在且非空；未传 `--rationale` 时若响应包含 `rationale` 字段则忽略之（不报错）。

### 5.4 置信度实现（`classification/confidence.ts`）

`confidence` 完全来源于 provider 的 logprobs——LLM **不**输出置信度字段。

**派生方式**（参考 `img-val/src/llm/response-parser.ts` 的 `meanLogprobForValue` 实现）：

1. 请求时向 provider 传 `logprobs: true, top_logprobs: 5`（OpenAI；Anthropic 不支持）
2. 从 `logprobs.tokens` 序列重建完整文本与每个 token 的字符区间
3. 用正则定位 `"category"` key 对应的字符串值（如 `"photo-portrait"`）的字符区间
4. 对该区间内所有重叠 token 的 `logprob` 求平均，得到 `mean_logprob`（即各重叠 token 的 logprob 的算术平均值）
5. 对 `mean_logprob` 取自然指数 `exp(mean_logprob)`，将其从对数概率转换为 [0, 1] 区间内的概率值，作为 `confidence`（注：`exp` 是自然指数函数 `e^x`；由于 `logprob` 以 e 为底，`exp(logprob)` 即还原为原始概率）

**Anthropic provider 不支持 logprobs**：
- 请求为普通文本 JSON，不带 logprob 信息
- `confidence` 字段为 NULL；`stats` 的 `avg_confidence` 计算忽略 NULL
- `search` 的 `min:`/`max:` 前缀（或 `--filter min=…`）阈值筛选时忽略 NULL 记录（不匹配）

**跨 provider 一致性**：同一张图片在 OpenAI 与 Anthropic 下 `confidence` 不可直接比较（前者有值、后者 NULL）。审计与校准建议只用 OpenAI 路径；跨 provider 场景仅比较 `category` 与 `rationale`。

**`enableLogprobs = false` 时**：不请求 logprobs，`confidence` 全为 NULL（行为同 Anthropic 路径）。配置层选择，CLI 无覆盖开关；工具照常工作。

### 5.5 写入流程

`--dry-run` 时跳过步骤 7–9（含 DELETE/INSERT 与 file-index 注册），仅输出结果。

```
1. 前置校验：文件存在、可解码；尺寸超限则自动缩放（见 §5.1）
2. 检查 `--mode skip` 命中（`image_hash + standard_hash`）→ 跳过（skip 语义对单图/批量均默认生效）
3. 组装 prompt → `runToolFlow`（`enableTools=false`，`responseFormat=classificationSchema(rationale)`（OpenAI）或文本 JSON（Anthropic），`logprobs=enableLogprobs`）
4. 解析响应 → 校验类别空间；若 `category` 不在集合内视为解析失败（重试，最多 `classifyRetries` 次）
5. 从 logprobs 派生 `confidence`（若 provider 不支持或 `enableLogprobs=false` 则 NULL）
6.（无阈值判定——不入库任何阈值标志）
7. `DELETE WHERE image_hash = ? AND standard_hash = ?`（到达写入步时**无条件先删后插**；skip 未命中时通常无旧行，DELETE 为空操作；`--mode full` 时必有旧行）
8. `INSERT classification`（含 `standard_hash`、`rationale`（未传 `--rationale` 时为 NULL）；`confidence` 可能为 NULL）
9. `register file-index`（若未登记）
```

一律入库：无论置信度高低、是否带 rationale，只要响应通过校验就写库。阈值筛选完全由用户**查询时**通过 `search`/`stats` 的 `min:`/`max:` 动态指定——每次不同均可，不依赖任何落库标志。

## 6. 失败处理与日志

### 6.1 批处理语义

与 `img-tagger` 一致：单图失败不影响其它图；失败图分**分类失败**（LLM 错误、响应解析失败、`category` 不在类别空间内）与**单图前置校验失败**（文件缺失、解码失败）。`--mode skip` 重跑跳过已分类成功的图。

### 6.2 重试策略

单图内**额外重试最多 2 次**（`classifyRetries`，默认 2，共最多 3 次尝试），仅对**响应解析失败**重试——`category` 缺失/非法/不在类别空间内、JSON 解析失败，以及传 `--rationale` 时 `rationale` 缺失；LLM API 错误按 shared provider 内置重试（额外重试通常 3 次，共 4 次尝试）；文件级错误不重试。每次重试在原 prompt 后追加一条用户消息：`"上一次响应无效：<错误原因>，请重新返回合法 JSON。"`。

### 6.3 failLogDir

与 `img-tagger` 一致地**收紧隐私**：

- 默认**禁用**（`failLogDir = ""`）
- 启用时**图片块一律替换为 `[图片内容省略]`**——不做 base64 入日志
- **不**默认记录 EXIF；`failLogIncludeExif = true` 才记录
- 只记录 LLM 分类流程失败；`search`/`stats`/`images prune`/`check` 等非 LLM 操作不写日志。日志文件命名约定：`<failLogDir>/<standard_name>-<YYYYMMDD>.log`（按标准与日期拆分）

## 7. 配置与数据

### 7.1 环境变量

与 `img-val` 一致：

| 变量 | 说明 |
|------|------|
| `OPENAI_API_BASE` / `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI 兼容配置 |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` / `ANTHROPIC_API_BASE` | Anthropic 配置 |
| `IMGDATA_DIR` | 统一数据目录（默认 `~/.img-data`） |

环境变量仅用于 **bootstrap**（provider 选择与密钥/模型回退），具体字段以 `imgclassify.toml` 为准：toml 未设置的 `llm.provider`、`llm.openai.apiBase/apiKey/model`、`llm.anthropic.apiKey/model/apiBase` 等可由对应环境变量回退填充；其余配置项不提供同名环境变量覆盖。

### 7.2 配置文件 `imgclassify.toml`

路径：`<IMGDATA_DIR>/imgclassify.toml`。（模型名为示意值）

```toml
standardsDir = "~/.img-data/classify-standards"
maxImageDimension = 1568
rationale = false
classifyRetries = 2
enableLogprobs = true
failLogDir = ""
failLogIncludeExif = false
promptIncludeExif = false
[llm]
provider = "openai"

[llm.openai]
apiBase = "https://api.openai.com/v1"
model = "gpt-5.6-luna"
visionDetail = "high"

[llm.anthropic]
model = "claude-sonnet-5"
apiBase = ""
```

### 7.3 配置字段说明

| 配置项 | 类型 / 默认 | 说明 |
|--------|-------------|------|
| `standardsDir` | string, `~/.img-data/classify-standards` | 分类标准目录 |
| `maxImageDimension` | int, `1568` | 送 LLM 前最长边限制 |
| `rationale` | bool, `false` | 分类时 LLM 是否输出原因（先原因后类别）；CLI `--rationale` 优先，未传时取本配置项（默认 false）；是否要求理由不影响入库 |
| `classifyRetries` | int, `2` | 单图内 LLM 响应解析失败重试次数 |
| `enableLogprobs` | bool, `true` | 是否请求 provider 返回 logprobs（`confidence` 唯一来源；`false` 时 confidence 全为 NULL） |
| `failLogDir` | string, `""` | 失败日志目录；空串禁用 |
| `failLogIncludeExif` | bool, `false` | 失败日志是否记录 EXIF（含 GPS） |
| `promptIncludeExif` | bool, `false` | 送 LLM 时是否附带 EXIF 摘要（默认剥离 GPS） |
| `llm.provider` | string, `openai` | LLM 厂商选择：`openai` / `anthropic`；toml 未设置时由环境变量 bootstrap |
| `llm.openai.apiBase` / `apiKey` / `model` / `visionDetail` | string | OpenAI 连接参数；`apiBase`/`apiKey`/`model` 可回退到对应环境变量 |
| `llm.anthropic.apiKey` / `model` / `apiBase` | string | Anthropic 连接参数；`apiKey`/`model`/`apiBase` 可回退到对应环境变量 |
## 8. CLI 命令详细规格

### 8.0 公共约定

所有命令输出 envelope 与 `img-val` 一致（`{ ok, data | error }`）；退出码沿用 `img-tagger` 设计（1 = LLM/校验、4 = 图片、5 = 存储），除 §8.6 `check` 另有说明外，所有命令出错时按此约定。CLI 参数错误（未知选项、非法参数值）与配置错误一律归入 1（校验类）。

### 8.1 `imgclassify <path|dir>` — 单图/批量分类

```
imgclassify <path>  [--standard <name|path>] [--mode <skip|full>] [--format text|json] [--verbose]
                    [--dry-run] [--rationale]
imgclassify <dir>   [--standard <name|path>] [--recursive] [--concurrency N]
                    [--include <glob>] [--progress] [--mode <skip|full>]
                    [--format text|json] [--verbose] [--dry-run] [--rationale]
```

选项说明：

| 选项 | 说明 |
|------|------|
| `--standard <name\|path>` | 分类标准；省略时默认 `default-general`（内置） |
| `--recursive` | 目录递归（仅批量） |
| `--include <glob>` | 文件筛选（可重复，仅批量） |
| `--concurrency N` | 并发数（默认 3，仅批量） |
| `--progress` | 进度条（仅批量） |
| `--mode <skip\|full>` | 默认 `skip`：`image_hash + standard_hash` 均匹配即跳过；`full`：全量重分类（单图/批量均适用） |
| `--dry-run` | 只输出分类结果，不写库 |
| `--format <text\|json>` | 输出格式 |
| `--rationale` | 布尔 flag：出现即 true（LLM 先输出原因 ≤200 字中文再输出类别），覆盖配置项 `rationale`（未传时取配置默认）；默认关闭 |
| `--verbose` | 完整错误栈、prompt 打印；EXIF 仅打印（不落盘）且剥离 GPS，与 §6.3 failLogDir 策略一致 |

### 8.2 `imgclassify standards list|show <name>`

```
imgclassify standards list
imgclassify standards show <name>
```

只读；不调 LLM。`list` 列出所有可用标准（内置 + 用户目录），`show <name>` 打印标准全文（frontmatter + body）。

### 8.3 `imgclassify search <query>`

```
imgclassify search [query] [--filter key=value...] [--limit N] [--format text|json]
```

支持的前缀：

| 前缀 | 语义 |
|------|------|
| `category:<name>` | 精确匹配类别（大小写敏感） |
| `category!:<name>` | 排除该类别 |
| `min:<0-1>` | 置信度 ≥ 阈值；无置信度（NULL）的记录不匹配该条件 |
| `max:<0-1>` | 置信度 ≤ 阈值；无置信度（NULL）的记录不匹配该条件 |
| `standard:<name>` | 匹配分类标准名称 |
| `from:<date>` / `to:<date>` | `classified_at` 区间 |

多条件 AND；无 query 且无 filter 时列出最近 N 条（默认 `--limit 50`）。

### 8.4 `imgclassify stats`

```
imgclassify stats [--standard <name>] [--filter key=value...] [--format text|json]
```

输出每类别的 `count`、`avg_confidence`、`min_confidence`、`max_confidence`；按 `count` 降序，同 count 时按类别名字节序稳定。`stats` 同样接受 `min:`/`max:` 动态阈值（经 `--filter` 传入），先过滤后聚合。

### 8.5 `imgclassify images prune`

删除 `classification` 表中两类记录：① 失效类别残留——`rationale` 为空且 `category` 在对应标准中已不存在；② 漂移记录——`rationale` 为空且通过 blake3 在 file-index 反查无结果。仅清理「无理由依据」的记录，避免误删带 rationale 的人工判定记录；若要清理全部失效类别，可扩展（如 `--all`，当前未实现）。默认 `--dry-run`，`--yes` 实际执行。

### 8.6 `imgclassify check`

五项检查：

1. `schema_version` 表存在且最新
2. 所有 `classification.category` 值在对应 `standard_hash` 版本的类别集合内（跨标准漂移检测）
3. 通过 **blake3** 在 file-index 反查（`image_hash` 为处理后内容 SHA-256，`blake3` 为原始文件指纹，反查以后者进行），无结果即漂移
4. 不存在「传了 `--rationale` 但 `rationale` 为 NULL」的记录（`rationale` 非空仅应在传 `--rationale` 时产生；未传时须为 NULL）
5. `classified_at` 为 UTC 时间戳（SQLite `datetime('now')` 格式 `YYYY-MM-DD HH:MM:SS`，非严格 ISO-8601）且 `standard_hash` 非空

只读；有异常时退出码 5（存储/一致性类，见 §8 公共约定）；`--format json` 输出结构化报告。

## 9. 查询系统实现

### 9.1 查询语法解析（`query/parser.ts`）

沿用 `img-val` 的 `key:value` 前缀式语法。解析器将查询字符串拆分为条件列表，每个条件为 `{ key, op, value }` 形式（如 `category:photo-portrait`、`min:0.8`、`category!:other`）。

### 9.2 查询到 SQL（`query/evaluate.ts`）

将解析后的条件列表映射为 SQL WHERE 子句：
- `category:<name>` → `category = ?`
- `category!:<name>` → `category != ?`
- `min:<value>` → `confidence >= ?`
- `max:<value>` → `confidence <= ?`
- `standard:<name>` → `standard_name = ?`
- `from:<date>` / `to:<date>` → `classified_at >= ?` / `classified_at <= ?`

所有条件以 AND 连接。

## 10. 统计系统实现（`stats/stats.ts`）

按 `standard_name`（可选）和 `category` 分组，执行 `COUNT(*)`、`AVG(confidence)`、`MIN(confidence)`、`MAX(confidence)`。当 `--filter` 传入 `min:`/`max:` 阈值时，先在子查询中过滤，再聚合。排序规则见 §8.4。

## 11. 并发控制

`--concurrency N` 控制并行分类数。实现要点：
- 不同 `image_hash` 的图片可并行
- 相同 `image_hash` 不并发（per-hash 串行）
- SQLite 使用 WAL 模式 + busy_timeout 避免 `SQLITE_BUSY`

## 12. 测试计划

- **standards/**：frontmatter 解析（合法/非法类别、空列表、缺 name）、body 类别覆盖校验（frontmatter 与 body 不一致时报错）、加载优先级（用户覆盖内置）、`standard_hash` 稳定性
- **classification/prompt.ts**：system prompt 结构（未传 `--rationale` 单字段输出 / 传 `--rationale` 先原因后类别两字段输出）、user prompt 组装（包含（`promptIncludeExif=true`）与不包含（默认）EXIF 两种路径、含/不含 undecodable、损坏状态行）
- **classification/response-parser.ts**：三路径 JSON 提取、zod 校验（`category` 枚举合法性）、类别空间校验（大小写、非法类别、frontmatter 内声明的兜底类别如 `other` 与真实类别同等对待）、`--rationale` 一致性（传 `--rationale` 时缺 rationale 报错 / 未传时多余 rationale 忽略）
- **classification/engine.ts**：`--mode skip` 命中/未命中（`image_hash`/`standard_hash` 各自变化）、`--rationale` 传递到 prompt 与 schema、`--dry-run` 无副作用、单图失败隔离、写入无阈值标志（`rationale=NULL` 仅在未传 `--rationale` 时产生）
- **classification/confidence.ts**：logprobs 派生（OpenAI 返回、不返回、`enableLogprobs=false`、token 未覆盖 category 值 → 均返回 NULL）、Anthropic 路径下字段 NULL、`exp(mean_logprob)` 数值稳定性（极小 logprob 不产出 NaN/0）
- **query/**：语法解析（`key:value`、组合条件、非法前缀）、SQL 生成（大小写敏感、`category`/`min`/`max`/`standard`/日期区间）
- **stats/**：COUNT 与 `AVG(confidence)`、`min`/`max` 动态过滤后聚合、标准过滤
- **storage/**：迁移 runner、uq 冲突删除路径、`images prune` 命中漂移记录、只读模式
- **check/**：五项检查各自命中/未命中、只读、`--format json` 结构、非零退出码
- **concurrency/**：`--concurrency N` 下不同 `image_hash` 并行、相同 `image_hash` 不并发（per-hash 串行）、批量下无 `SQLITE_BUSY`（WAL + busy_timeout）
- **fail-log/**：图片块替换为占位符、默认不记录 EXIF、`failLogIncludeExif = true` 记录、非 LLM 操作不写入、`--dry-run` 不写入
- **端到端冒烟**：fixtures 图片分类 → `search category:other` → `stats` → `images prune` → `check`

## 13. 后续实施顺序

1. **骨架**：`package.json`、`tsconfig*`、`vitest.config.ts`、`src/index.ts`、`cli/index.ts`（commander 命令注册）；`config/*`（env / config / paths）
2. **共享层集成**：`storage/db.ts`、`storage/migrations/001_init.sql`、`fileindex.ts`
3. **标准系统**：`standards/parser.ts`、`standards/loader.ts`、`assets/standards/builtin/default-general.md`
4. **分类引擎**：`classification/prompt.ts`、`response-parser.ts`、`engine.ts`、`confidence.ts`
5. **CLI 主路径**：`cli/classify.ts`（单图 + 批量）
6. **CLI 副路径**：`cli/search.ts`、`cli/stats.ts`、`cli/standards.ts`、`cli/images.ts`、`cli/check.ts`
7. **测试**：按 §12 逐项补齐
8. **README + ADR**（如有决策分歧）

