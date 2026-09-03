# img-search

Intelligent image search via LLM-driven interactive questioning.

用户心中有一张目标图片，img-search 通过向用户反复提问（0~1 值或"不知道"），用贝叶斯推理逐步缩小候选集，以最少提问次数从十万级图片库中定位目标。

## 工作原理

```
1. 初始化 beam（500 候选）
   - 有提示词: Qdrant 语义搜索 → 取 top 500
   - 无提示词: Qdrant 随机采样 500

2. 每轮提问:
   a. 取 beam top-50 候选的描述
   b. LLM 生成 1~5 个区分性问题
   c. 对每个问题计算期望信息增益（IG）
   d. 选择 IG 最高的问题；若 IG < 阈值 → 终止
   e. 用户回答 0~1 或 "不知道"
   f. 贝叶斯更新: p_i *= exp(-λ·(answer - s_i)²)
   g. 检查终止: 置信度 > 0.9 或 达到最大轮数

3. 终止后展示 top-5 结果
```

### 核心算法

- **贝叶斯更新**：高斯似然核 `L_i = exp(-λ·(a - s_i)²)`，其中 `a` 是用户回答，`s_i` 是图片 i 对该问题的匹配度
- **匹配度计算**：`s_i = α·cos(q_vec, text_vec_i) + (1-α)·cos(q_vec, visual_vec_i)`，文本和视觉向量的加权余弦相似度
- **期望信息增益**：将答案离散化为 10 个 bin，计算每个 bin 的后验熵，选择 IG 最大的问题
- **Beam search**：500 候选工作集在内存中维护，Qdrant 作为外部记忆索引

### 边缘情况

| 情况       | 处理                                        |
| ---------- | ------------------------------------------- |
| 同质候选集 | 多样性 < 0.1 时终止                         |
| Beam 崩溃  | 从先验重新采样 500 候选                     |
| "不知道"   | 不更新概率，对相似问题施加 IG 惩罚          |
| 目标不在库 | 最大轮数后置信度 < 0.5 → 报告"可能不在库中" |
| 最小轮数   | 轮数 < min_rounds 时不允许 IG 阈值终止      |

## 前置条件

- Node.js >= 22
- [Qdrant](https://qdrant.tech/) 向量数据库（本地 Docker 或远程）
- LLM API key（OpenAI 或 Anthropic）
- [Jina AI](https://jina.ai/) API key（用于多模态 embedding）

### 启动 Qdrant

```bash
docker run -p 6333:6333 qdrant/qdrant
```

## 安装

本项目是 pnpm monorepo 的一部分，在仓库根目录执行：

```bash
pnpm install
```

## 配置

在 `img-search/` 下创建 `.env` 文件（参考 `.env.example`）：

```env
# LLM（问题生成）
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o

# Embedding（Jina CLIP v2）
JINA_API_KEY=jina_...
JINA_MODEL=jina-clip-v2

# Qdrant
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=images
```

### 环境变量

LLM 提供商、向量库与数据库目录通过环境变量配置。其中 `OPENAI_*` / `ANTHROPIC_*` 字段优先从下方 config.toml 的 `[llm]` 段读取，缺失时回退到下列环境变量。其余环境变量：

| 变量                | 默认值                       | 说明                              |
| ------------------- | ---------------------------- | --------------------------------- |
| `OPENAI_API_KEY`    | —                            | OpenAI API 密钥                   |
| `OPENAI_MODEL`      | `gpt-4o`                     | OpenAI 模型                       |
| `ANTHROPIC_API_KEY` | —                            | Anthropic API 密钥                |
| `ANTHROPIC_MODEL`   | `claude-sonnet-4-5-20250929` | Anthropic 模型                    |
| `JINA_API_KEY`      | —                            | Jina AI API 密钥                  |
| `JINA_MODEL`        | `jina-clip-v2`               | embedding 模型                    |
| `JINA_API_BASE`     | `https://api.jina.ai/v1`     | Jina API 地址                     |
| `JINA_DIMENSIONS`   | `1024`                       | 向量维度                          |
| `QDRANT_URL`        | `http://localhost:6333`      | Qdrant 地址                       |
| `QDRANT_COLLECTION` | `images`                     | Qdrant collection 名              |
| `QDRANT_API_KEY`    | —                            | Qdrant API 密钥（远程部署时使用） |
| `IMGDATA_DIR`       | `~/.img-data`                | 统一数据目录（img-search/img-tagger/img-val/file-index 共用，SQLite 库 `imgsearch.db` 与配置文件 `imgsearch.toml` 均存放于此；file-index 的 `file-index.db` 亦在此目录下） |

### 配置文件

算法、导入调优参数与 LLM provider 配置统一放在配置文件 `~/.img-data/imgsearch.toml`（若设置了 `IMGDATA_DIR`，则为 `<IMGDATA_DIR>/imgsearch.toml`）。文件不存在时全部使用默认值。`[llm]` 段中已设置的 provider 字段优先于同名环境变量，未设置的字段回退环境变量；`visionDetail` 仅从配置读取（默认 `low`），无环境变量。`[llm].provider` 指定走哪个提供商，未设置时按已配置的 apiKey 自动选择（双方都在→报错，都没有→报错）。其余调优参数为唯一来源，无同名环境变量覆盖。

```toml
# ~/.img-data/imgsearch.toml

[llm]
provider = "openai"   # 可选；未设置时按已配置的 apiKey 自动选择（双方都在→报错，都没有→报错）

[llm.openai]
apiBase = "https://api.openai.com/v1"   # 缺失时回退 OPENAI_API_BASE 环境变量
apiKey = "sk-..."                        # 缺失时回退 OPENAI_API_KEY 环境变量
model = "gpt-4o"                         # 缺失时回退 OPENAI_MODEL 环境变量
visionDetail = "low"                     # 仅配置（默认 low，无环境变量）

[llm.anthropic]
apiKey = "sk-ant-..."                    # 缺失时回退 ANTHROPIC_API_KEY 环境变量
model = "claude-sonnet-4-5-20250929"     # 缺失时回退 ANTHROPIC_MODEL 环境变量
apiBase = ""                             # 缺失时回退 ANTHROPIC_API_BASE 环境变量（可选）

alpha = 0.5              # 文本/视觉相似度 blend 权重 (0~1)
lambda = 8               # 似然核锐度，越大越尖锐
beamSize = 500           # beam 候选数量
topKQuestions = 50       # 问题生成时取 top-N 候选
candidateQuestions = 5   # 每轮生成候选问题数上限
igThreshold = 0.05       # 信息增益终止阈值 (nats)
maxRounds = 8            # 最大提问轮数
minRounds = 2            # 最小提问轮数（在此之前不允许 IG 终止）
showThumbnails = false   # 是否在提问时给 LLM 看候选缩略图

# 导入
maxImageDimension = 512  # 导入时图片最大边长 (px)
importConcurrency = 4    # 默认导入并发数（--concurrency 可临时覆盖）
embedTextBatch = 64      # 文本 embedding 批大小
embedImageBatch = 16     # 图片 embedding 批大小
```

## 使用

### 导入图片

```bash
# 导入目录中的图片（不递归）
pnpm --filter img-search dev -- import ./photos

# 递归导入，指定并发数
pnpm --filter img-search dev -- import ./photos --recursive --concurrency 8

# 指定文件类型
pnpm --filter img-search dev -- import ./photos --include "*.{jpg,png}"
```

导入流程：

1. 遍历目录收集图片文件
2. `blake3HexFile` 计算原始文件 BLAKE3 指纹
3. file-index 按 `blake3` 去重（已登记非失败状态 → 跳过，避免重读同一原始文件）
4. `sharp` 缩放图片 → base64 + 处理后 `hash`（SHA-256，视觉内容指纹）
5. image_import 按 `hash` 去重：仅 EXIF 不同的两张图片 `blake3` 不同但 `hash` 相同 → 跳过第二张（避免重复 LLM 描述 + embedding + Qdrant 写入），但仍将其 `blake3` 登记到 file-index 以追踪其 url
6. LLM 生成文本描述
7. Jina 生成文本和视觉 embedding
8. Qdrant upsert（point ID = SQLite 行 ID，payload 含 `blake3` + `hash` + `description`）
9. 更新 SQLite 状态为 `indexed`
10. `register` 至 file-index（登记 `url`/`type`/`size` —— 文件元信息由 file-index 统一管理；每个原始 `blake3` 都被追踪，即便其视觉 `hash` 与已有文件冲突）

导入是可恢复的：中断后重新运行，已索引的图片会跳过，未完成的会续传。

### 搜索图片

```bash
# 无提示词搜索（随机采样候选）
pnpm --filter img-search dev -- search

# 带提示词搜索（语义搜索 bootstrap 候选集）
pnpm --filter img-search dev -- search --hint "sunset over ocean"

# JSON 输出
pnpm --filter img-search dev -- search --hint "cat playing" --json
```

交互流程：

```
[Round 1] Top candidates:
  1. A golden retriever playing in a park (12.3%)
  2. A cat sleeping on a sofa (10.8%)
  ...

Question: 图片中是否有水面？
Rationale: 区分自然风景与室内场景
Your answer (0-1 or "unknown"): 0.8
```

用户回答语义：

- `0` — 完全不是
- `1` — 完全是
- `0.5` — 不确定/部分符合
- `unknown` 或 `?` — 不知道

### 查看库状态

```bash
pnpm --filter img-search dev -- status

# JSON 输出
pnpm --filter img-search dev -- status --json
```

输出示例：

```
图片库状态:
  总计: 1024
  已索引: 1000
  待处理: 0
  处理中: 0
  已嵌入: 0
  失败: 24
```

## 架构

```
img-search/src/
├── cli/                    # CLI 命令
│   ├── index.ts            # commander 入口
│   ├── import.ts           # 导入命令
│   ├── search.ts           # 交互式搜索命令
│   └── status.ts           # 状态查询命令
├── config/
│   ├── config.ts           # ~/.img-data/imgsearch.toml（zod + smol-toml 校验）
│   ├── env.ts              # zod 环境变量校验
│   └── paths.ts            # 数据目录路径
├── embedding/
│   ├── provider.ts         # EmbeddingProvider 接口
│   ├── jina.ts             # Jina CLIP v2 adapter
│   └── factory.ts          # provider 工厂
├── storage/
│   ├── db.ts               # SQLite 连接 + migration
│   ├── qdrant.ts           # Qdrant 向量存储
│   ├── types.ts            # 数据类型（含 blake3 + hash）
│   ├── repository.image.ts # image_import 表 CRUD（按 blake3 / hash）
│   └── migrations/
│       ├── 001_init.sql               # 初始 schema（已废弃 source_path）
│       └── 002_drop_source_path_hash_add_blake3.sql
├── search/                 # 核心搜索算法
│   ├── bayes.ts            # 贝叶斯更新、信息增益、多样性（纯函数）
│   ├── beam.ts             # Beam 类（候选集管理）
│   ├── algorithm.ts        # 搜索循环编排（路径经 file-index 反查）
│   ├── session.ts          # 会话状态管理
│   ├── question-prompt.ts  # LLM prompt 构建
│   ├── question-parser.ts  # 响应解析（4 级 fallback）
│   ├── question-flow.ts    # 问题生成编排
│   └── describe.ts         # LLM 图片描述生成
├── image/
│   └── collect.ts          # 目录遍历收集图片
├── fileindex.ts            # @llm-image/file-index repo 单例
└── index.ts                # CLI 入点
```

### 数据存储

- **SQLite** (`~/.img-data/imgsearch.db`)：导入状态、描述文本；以 `blake3`（原始文件指纹，file-index 关联键）+ `hash`（处理后视觉指纹，UNIQUE 去重键）为两列
- **file-index** (`~/.img-data/file-index.db`，经 `@llm-image/file-index`)：文件元信息（`url`/`type`/`size`），与 img-tagger/img-val 共享；追踪每个原始文件的 `blake3`
- **Qdrant**：向量索引（text + visual named vectors，1024 维 Cosine 距离）；payload 含 `blake3` + `hash` + `description`

### 依赖关系

- `@llm-image/shared` — 共享基础设施（LLM provider、图片处理、SQLite、错误处理）
- `@llm-image/file-index` — 文件元信息统一管理（BLAKE3 指纹、url、type、size）
- `@qdrant/js-client-rest` — Qdrant 客户端
- `commander` — CLI 框架
- `es-toolkit` — 工具函数（并发控制等）
- `smol-toml` — TOML 配置文件解析
- `zod` — 环境变量与配置校验

## 开发

```bash
# 运行测试
pnpm --filter img-search test

# 类型检查
pnpm --filter img-search typecheck

# 编译
pnpm --filter img-search build

# 开发模式运行（通过 tsx）
pnpm --filter img-search dev -- <command>

# 生产模式运行（编译后）
pnpm --filter img-search start -- <command>
```

### 测试

45 个单元测试覆盖核心算法：

- `bayes.test.ts`（23 测试）：余弦相似度、贝叶斯更新、信息增益、多样性、温和更新
- `beam.test.ts`（14 测试）：CRUD、topK、prune、序列化
- `question-parser.test.ts`（8 测试）：tool call、JSON、code fence、regex fallback
