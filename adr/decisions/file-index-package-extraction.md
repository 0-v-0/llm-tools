# 提取 @llm-image/file-index 共享包

## 背景

img-search 与 img-val 都需要管理文件元数据：文件指纹计算、URL/路径/MIME 处理、文件元信息（路径、类型、大小）的存储与反查。此前各工具独立实现这些逻辑——img-search 在 `image_import` 表中存储 `source_path`，img-val 在 valuation 记录中存储 `url`。

随着功能演进，独立实现的痛点逐渐显现：

- **逻辑重复与漂移风险**：两个工具各自维护指纹计算、URL 转换、元信息存储，实现细节不一致时难以发现。
- **跨工具文件去重缺失**：同一物理文件被两个工具分别处理时，各自独立登记，无法共享元信息。
- **元信息与文件实际状态脱节**：img-search 的 `source_path` 在文件移动/重命名后失效，无法可靠反查。

## 核心决策

提取 `@llm-image/file-index` 为 pnpm workspace 共享包，作为文件元数据管理的唯一来源。

- **包职责**：
  - `blake3HexFile`：原始文件 BLAKE3 指纹计算（内容寻址键）。
  - `FileIndexRepo`：基于 SQLite 的文件元信息 CRUD，以 `blake3` 为关联键存储与反查 `url`/`type`/`size` 等。
  - `toFileUrl` / `mimeFromUrl` / `fileUrlToPath`：URL 与 MIME 工具函数。
  - `verify`：文件完整性校验。
- **workspace 集成**：加入 `pnpm-workspace.yaml`；img-search 与 img-val 各自在 `package.json` 添加 `@llm-image/file-index` 依赖。
- **接入方式**：各工具新增 `src/fileindex.ts` 封装 `FileIndexRepo` 单例与元信息反查逻辑。
- **数据库**：`file-index.db` 存放于统一数据目录（见 [`adr/decisions/unified-data-dir.md`](unified-data-dir.md)），各工具只读访问（写入仅在登记新文件时经 `FileIndexRepo.register`）。

核心模块：`file-index/src/`（指纹、仓储、校验、URL 工具、CLI），各消费方的 `src/fileindex.ts`（repo 单例与元信息反查封装）。

## 权衡分析

**方案 A：各工具独立维护文件元数据逻辑**

- 优点：无包间依赖，各工具完全自治。
- 缺点：逻辑重复，实现漂移风险高；跨工具文件去重不可能（同一文件被多工具处理时各自独立登记）。

**方案 B：提取共享 file-index 包**（已选择）

- 优点：文件元数据单一来源；跨工具去重（同一物理文件登记一次，以 `blake3` 反查）；指纹与 URL 工具函数统一。
- 缺点：新增 workspace 依赖与耦合；file-index 的 schema 变更可能影响所有消费方。

**方案 C：将元数据逻辑放入 `@llm-image/shared`**

- 优点：不新增包，依赖关系更简单。
- 缺点：`shared` 定位为基础设施（LLM provider、图片处理、SQLite 存储、错误处理），文件索引是有独立职责的领域模块，混入会模糊 shared 的边界，且 file-index 有独立的 CLI 与数据库。

选择 B 的关键依据：文件元数据管理是有独立职责的领域（独立数据库、独立 CLI、可复用指纹与反查逻辑），值得作为独立包；跨工具去重是其核心价值，方案 A 和 C 都无法实现。

## 影响范围

- 新增 workspace 包 `file-index/`，`pnpm-workspace.yaml` 更新。
- img-search 与 img-val 新增 `@llm-image/file-index` 依赖。
- img-search 的 `image_import` 表 schema 变更（`source_path` → `blake3`），见 [`img-search/adr/decisions/file-index-metadata-management.md`](../../img-search/adr/decisions/file-index-metadata-management.md)。
- img-val 通过 `src/fileindex.ts` 接入，在打标/估值流程中经 `blake3HexFile` 计算指纹并 `register` 至 file-index。
- img-tagger 的设计文档规划直接依赖 `@llm-image/file-index`，`image` 表仅存 `blake3` 关联键，不保存 `url`/`format`/`size`（由 file-index 管理）。
