# img-search 实现说明

本文档描述 img-search 的内部结构、存储 schema 与内部流程（「怎么实现」）。设计决策与权衡依据见 [file-index-metadata-management.md](../adr/decisions/file-index-metadata-management.md)（文件定位键：以原始文件指纹替代文件路径）及仓库根级 `adr/decisions/` 下的相关决策。

## 模块结构

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
│       └── 001_init.sql               # 初始 schema（blake3 + hash 双指纹列）
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

## 数据存储

- **SQLite**（`~/.img-data/imgsearch.db`）：导入状态、描述文本。`image_import` 表以 `blake3`（原始文件指纹，file-index 关联键）+ `hash`（处理后视觉指纹，UNIQUE 去重键）为两列
- **file-index**（`~/.img-data/file-index.db`，经 `@llm-image/file-index`）：文件元信息（`url`/`type`/`size`），与 img-tagger/img-val 共享；追踪每个原始文件的 `blake3`
- **Qdrant**：向量索引（text + visual named vectors，1024 维 Cosine 距离）；payload 含 `blake3` + `hash` + `description`；point ID = SQLite 行 ID

### image_import 与迁移

- `001_init.sql`：初始 schema——`blake3`（原始文件指纹，file-index 关联键）+ `hash`（UNIQUE，处理后视觉指纹，去重键）双指纹列。历史数据（旧版 `source_path` schema）不迁移（取舍依据见 [file-index-metadata-management.md](../adr/decisions/file-index-metadata-management.md)）。

## 导入流程

1. 遍历目录收集图片文件
2. `blake3HexFile` 计算原始文件 BLAKE3 指纹
3. `image_import` 按 `blake3` 去重（已有 `status='indexed'` 记录 → 跳过，避免重读同一原始文件）
4. `sharp` 缩放图片 → base64 + 处理后 `hash`（SHA-256，视觉内容指纹）
5. `image_import` 按 `hash` 去重：仅 EXIF 不同的两张图片 `blake3` 不同但 `hash` 相同 → 跳过第二张（避免重复 LLM 描述 + embedding + Qdrant 写入），但仍将其 `blake3` 登记到 file-index 以追踪其 url；若既有记录状态为 `failed`/`processing`（上次中断或失败遗留）则复用该行重试
6. LLM 生成文本描述
7. Jina 生成文本和视觉 embedding
8. Qdrant upsert（point ID = SQLite 行 ID，payload 含 `blake3` + `hash` + `description`）
9. 更新 SQLite 状态为 `indexed`
10. `register` 至 file-index（登记 `url`/`type`/`size`——文件元信息由 file-index 统一管理；每个原始 `blake3` 都被追踪，即便其视觉 `hash` 与已有文件冲突）

导入是可恢复的：中断后重新运行，已索引的图片会跳过，未完成的会续传。

## 搜索流程

- beam 候选集（大小由配置 `beamSize` 控制）在内存中维护，Qdrant 作为外部记忆索引
- 有提示词：Qdrant 语义搜索取 top 候选；无提示词：Qdrant scroll 按 id 顺序确定性取前 beamSize 条（非随机）
- 每轮取 top-50 候选描述，LLM 生成候选问题，按期望信息增益选择
- 文件路径反查：`algorithm.ts` 中经 file-index 间接获取（`image_import.blake3` → file-index 元信息）

## 依赖关系

- `@llm-image/shared` — 共享基础设施（LLM provider、图片处理、SQLite、错误处理）
- `@llm-image/file-index` — 文件元信息统一管理（BLAKE3 指纹、url、type、size）
- `@qdrant/js-client-rest` — Qdrant 客户端
- `commander` — CLI 框架
- `es-toolkit` — 工具函数（并发控制等）
- `smol-toml` — TOML 配置文件解析
- `zod` — 环境变量与配置校验
