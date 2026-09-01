# 用 file-index 管理文件元数据：source_path → blake3

## 背景

img-search 的 `image_import` 表原以 `source_path`（原始文件路径）作为文件定位键。该设计存在根本缺陷：

- **路径不可靠**：文件被移动或重命名后，`source_path` 即失效，无法反查到对应记录。路径是易变的，不适合作为持久标识。
- **元数据重复**：`source_path` 中的路径、文件类型、大小等信息，`@llm-image/file-index` 已统一管理（见 [`adr/decisions/file-index-package-extraction.md`](../../../adr/decisions/file-index-package-extraction.md)），形成双写。

## 核心决策

将 `image_import` 表的文件定位键从 `source_path` 替换为 `blake3`（原始文件 BLAKE3 指纹），作为 `@llm-image/file-index` 的关联键。迁移 `002_drop_source_path_hash_add_blake3.sql` 采用破坏性 DROP + 重建。

### 双指纹设计

- **`blake3`**（原始文件指纹，非 UNIQUE）：原始文件内容的 BLAKE3 哈希，作为 file-index 的关联键。两张仅 EXIF 不同的图片 blake3 不同，但可共用同一行 `image_import`（因 `hash` 相同）。
- **`hash`**（处理后图片指纹，UNIQUE）：经 sharp 缩放 + JPEG 重编码 + EXIF 剥离后的 SHA-256，作为视觉内容去重键。仅 EXIF 不同的图片 `hash` 相同，重复插入时被跳过，避免对同一视觉内容重复索引（节省 LLM 描述 + embedding + Qdrant 写入）。

### 接口变更

- 记录与插入类型中 `sourcePath` 字段替换为 `blake3`。
- 按 `source_path` 查询改为按 `blake3` 查询。
- 导入流程变更：先经 file-index 计算原始文件 BLAKE3，再 `register` 至 file-index，以 `blake3` 作为 `image_import` 的关联键。

核心模块：`img-search/src/storage/`（迁移与仓储）、`img-search/src/cli/`（导入流程）、`img-search/src/search/`（搜索算法路径反查）。

## 权衡分析

**方案 A：保留 `source_path`，额外添加 `blake3`**

- 优点：不丢历史数据，可渐进迁移。
- 缺点：双写 `source_path` 与 file-index 元信息，漂移风险持续存在；`source_path` 仍不可靠（移动/重命名后失效）。

**方案 B：替换 `source_path` 为 `blake3`**（已选择）

- 优点：单一关联键指向 file-index，元信息由 file-index 统一管理；路径失效问题消除（blake3 是内容指纹，不随路径变化）。
- 缺点：无法从 `image_import` 直接反查文件路径——必须经 file-index 间接获取。无向后数据迁移（DROP + 重建）。

**不迁移历史数据的依据**：legacy `source_path` 已不可靠（文件可能已移动），迁移其值无意义。重建后重新 import 即可——file-index 的 dedup + Qdrant 的 upsert 均幂等，已索引的视觉内容会被 `hash` UNIQUE 约束跳过，不会重复处理。

**`blake3` 非 UNIQUE 的依据**：两张仅 EXIF 不同的图片 blake3 不同但视觉内容相同（`hash` 相同）。若 blake3 设为 UNIQUE，第二张图片的 blake3 会冲突导致插入失败；设为非 UNIQUE 允许在 `hash` 冲突时跳过，仅保留首张的 blake3。

## 影响范围

- **Schema 变更**（破坏性）：迁移 `002` DROP + 重建 `image_import` 表。历史数据丢失，需重新 import（file-index dedup + Qdrant upsert 幂等，已索引内容自动跳过）。
- **Breaking Change（接口）**：记录与插入类型的 `sourcePath` 字段移除，替换为 `blake3`；按路径查询改为按 blake3 查询。
- **导入流程变更**：导入时需先计算 `blake3` 并 `register` 至 file-index。
- **搜索流程变更**：路径反查改为从 `image_import.blake3` 经 file-index 间接获取。
- 依赖 [`adr/decisions/file-index-package-extraction.md`](../../../adr/decisions/file-index-package-extraction.md) 中提取的 `@llm-image/file-index` 包。
