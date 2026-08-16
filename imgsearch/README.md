# imgsearch

Intelligent image search via LLM-driven interactive questioning.

用户心中有一张目标图片，imgsearch 通过向用户反复提问（0~1 值或"不知道"），用贝叶斯推理逐步缩小候选集，以最少提问次数从十万级图片库中定位目标。

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

在 `imgsearch/` 下创建 `.env` 文件（参考 `.env.example`）：

```env
# LLM（问题生成）
LLM_PROVIDER=openai
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

仅 LLM 提供商、向量库与数据库目录通过环境变量配置：

| 变量                | 默认值                       | 说明                              |
| ------------------- | ---------------------------- | --------------------------------- |
| `LLM_PROVIDER`      | `openai`                     | LLM 提供商：`openai` 或 `anthropic` |
| `OPENAI_API_KEY`    | —                            | OpenAI API 密钥                   |
| `OPENAI_MODEL`      | `gpt-4o`                     | OpenAI 模型                       |
| `OPENAI_VISION_DETAIL` | `low`                     | 图片视觉精度：`low`/`high`/`auto` |
| `ANTHROPIC_API_KEY` | —                            | Anthropic API 密钥                |
| `ANTHROPIC_MODEL`   | `claude-sonnet-4-5-20250929` | Anthropic 模型                    |
| `JINA_API_KEY`      | —                            | Jina AI API 密钥                  |
| `JINA_MODEL`        | `jina-clip-v2`               | embedding 模型                    |
| `JINA_API_BASE`     | `https://api.jina.ai/v1`     | Jina API 地址                     |
| `JINA_DIMENSIONS`   | `1024`                       | 向量维度                          |
| `QDRANT_URL`        | `http://localhost:6333`      | Qdrant 地址                       |
| `QDRANT_COLLECTION` | `images`                     | Qdrant collection 名              |
| `QDRANT_API_KEY`    | —                            | Qdrant API 密钥（远程部署时使用） |
| `IMGSEARCH_DB_DIR`  | `~/.imgsearch`               | SQLite 数据库目录（配置文件也存放于此） |

### 配置文件

算法与导入调优参数统一放在配置文件 `~/.imgsearch/config.toml`（若设置了 `IMGSEARCH_DB_DIR`，则为 `<IMGSEARCH_DB_DIR>/config.toml`）。文件不存在时全部使用默认值；配置为唯一来源，无同名环境变量覆盖。

```toml
# ~/.imgsearch/config.toml
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
pnpm --filter imgsearch dev -- import ./photos

# 递归导入，指定并发数
pnpm --filter imgsearch dev -- import ./photos --recursive --concurrency 8

# 指定文件类型
pnpm --filter imgsearch dev -- import ./photos --include "*.{jpg,png}"
```

导入流程：

1. 遍历目录收集图片文件
2. sharp 处理图片 → 元数据 + base64 + hash
3. hash 去重（跳过已导入的图片）
4. LLM 生成文本描述
5. Jina 生成文本和视觉 embedding
6. Qdrant upsert（point ID = SQLite 行 ID）
7. 更新 SQLite 状态为 `indexed`

导入是可恢复的：中断后重新运行，已索引的图片会跳过，未完成的会续传。

### 搜索图片

```bash
# 无提示词搜索（随机采样候选）
pnpm --filter imgsearch dev -- search

# 带提示词搜索（语义搜索 bootstrap 候选集）
pnpm --filter imgsearch dev -- search --hint "sunset over ocean"

# JSON 输出
pnpm --filter imgsearch dev -- search --hint "cat playing" --json
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
pnpm --filter imgsearch dev -- status

# JSON 输出
pnpm --filter imgsearch dev -- status --json
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
imgsearch/src/
├── cli/                    # CLI 命令
│   ├── index.ts            # commander 入口
│   ├── import.ts           # 导入命令
│   ├── search.ts           # 交互式搜索命令
│   └── status.ts           # 状态查询命令
├── config/
│   ├── config.ts           # ~/.imgsearch/config.toml（zod + smol-toml 校验）
│   ├── env.ts              # zod 环境变量校验
│   └── paths.ts            # 数据目录路径
├── embedding/
│   ├── provider.ts         # EmbeddingProvider 接口
│   ├── jina.ts             # Jina CLIP v2 adapter
│   └── factory.ts          # provider 工厂
├── storage/
│   ├── db.ts               # SQLite 连接 + migration
│   ├── qdrant.ts           # Qdrant 向量存储
│   ├── types.ts            # 数据类型
│   ├── repository.image.ts # image_import 表 CRUD
│   └── migrations/
│       └── 001_init.sql    # 初始 schema
├── search/                 # 核心搜索算法
│   ├── bayes.ts            # 贝叶斯更新、信息增益、多样性（纯函数）
│   ├── beam.ts             # Beam 类（候选集管理）
│   ├── algorithm.ts        # 搜索循环编排
│   ├── session.ts          # 会话状态管理
│   ├── question-prompt.ts  # LLM prompt 构建
│   ├── question-parser.ts  # 响应解析（4 级 fallback）
│   ├── question-flow.ts    # 问题生成编排
│   └── describe.ts         # LLM 图片描述生成
├── image/
│   └── collect.ts          # 目录遍历收集图片
└── index.ts                # CLI 入点
```

### 数据存储

- **SQLite** (`~/.imgsearch/imgsearch.db`)：图片元数据、导入状态、描述文本
- **Qdrant**：向量索引（text + visual named vectors，1024 维 Cosine 距离）

### 依赖关系

- `@llm-image/shared` — 共享基础设施（LLM provider、图片处理、SQLite、错误处理）
- `@qdrant/js-client-rest` — Qdrant 客户端
- `commander` — CLI 框架
- `es-toolkit` — 工具函数（并发控制等）
- `smol-toml` — TOML 配置文件解析
- `zod` — 环境变量与配置校验

## 开发

```bash
# 运行测试
pnpm --filter imgsearch test

# 类型检查
pnpm --filter imgsearch typecheck

# 编译
pnpm --filter imgsearch build

# 开发模式运行（通过 tsx）
pnpm --filter imgsearch dev -- <command>

# 生产模式运行（编译后）
pnpm --filter imgsearch start -- <command>
```

### 测试

45 个单元测试覆盖核心算法：

- `bayes.test.ts`（23 测试）：余弦相似度、贝叶斯更新、信息增益、多样性、温和更新
- `beam.test.ts`（14 测试）：CRUD、topK、prune、序列化
- `question-parser.test.ts`（8 测试）：tool call、JSON、code fence、regex fallback
