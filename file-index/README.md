# @llm-image/file-index

img-* 系列工具共享的**文件元数据统一管理**包：以 BLAKE3 内容指纹为核心，统一存储文件的 URL 位置、MIME 类型、大小与校验状态，并提供指纹计算、URL/MIME 工具与 SQLite 仓储。

包的定位：

- **文件指纹**：对本地文件、缓冲、字符串与 data: URI 计算 BLAKE3 摘要（内容寻址键）。
- **URL / MIME 工具**：文件路径 ↔ file URL 互转、URL 规范化与协议分类、按扩展名/URL 推断 MIME 类型。
- **SQLite 仓储**：以指纹为关联键，登记与反查文件的 URL 位置与元信息；支持完整性校验与失效清理。
- **完整性校验**：按内容重新计算指纹（或对远程 URL 探活），更新记录的校验状态。

## 安装与使用

本包通过 pnpm workspace 提供给仓库内的其它包消费：

```bash
pnpm --filter <子项目名> add @llm-image/file-index
```

代码中以包名直接导入：

```ts
import { openFileIndexDb, FileIndexRepo, blake3HexFile } from '@llm-image/file-index';
```

同时提供 `file-index` 命令行入口（见 `package.json` 的 `bin`；需先构建）：用于在 shell 中注册、校验、列出与清理索引记录。

## 数据库文件位置与读写约定

- 数据库文件默认为 `~/.img-data/file-index.db`；可用环境变量 `IMGDATA_DIR` 将整个数据目录重定位（此时为 `<IMGDATA_DIR>/file-index.db`）。
- 数据库由多个工具**共享**。作为库使用者：
  - **写入**仅发生在登记新文件 / 更新校验状态时（通过仓储的登记与状态更新接口，或 CLI 命令）。
  - 除此之外，各工具应将其视为**只读**数据源，不要自行建表或修改结构；结构由库的内部迁移管理。
- 文件记录的关联键为 BLAKE3 指纹：同一物理文件在不同工具间只登记一次，凭指纹即可跨工具反查其 URL 位置。

## 构建要求

- `file-index` 需**先编译**，其它包才能解析到它的产物（`dist/`）：`pnpm --filter @llm-image/file-index build`。
- 构建会同时生成 CLI 入口（`file-index` 命令）与库入口（`dist/index.js` / 类型声明）。
- 开发模式直跑源码：`pnpm --filter @llm-image/file-index dev`；类型检查：`pnpm --filter @llm-image/file-index typecheck`；测试：`pnpm --filter @llm-image/file-index test`。

## 公共 API 面

以下符号经包入口聚合导出，构成对外契约（按功能分组）：

### 指纹

- `blake3Hex()` / `blake3HexString()`：对字节缓冲 / UTF-8 字符串计算 BLAKE3 十六进制摘要
- `blake3HexFile()`：对本地文件流式计算 BLAKE3 摘要
- `blake3HexDataUri()`：对 data: URI 解码后计算 BLAKE3 摘要
- `createBlake3Hasher()`：创建流式 BLAKE3 哈希器

### URL / MIME 工具

- `classifyUrl()`、`normalizeUrl()`、`decodeUrl()`、`encodeFileUrl()`、`fileUrlToPath()`、`toFileUrl()`、`protocolPriority()`、`PROTOCOL_ORDER`、类型 `Protocol`
- `mimeFromUrl()`、`mimeFromDataUri()`、`mimeFromExtension()`

### SQLite 仓储

- `openFileIndexDb()`：打开数据库（自动应用内部迁移），返回 `DB`
- `getFileIndexDbPath()`：返回默认数据库文件路径
- `FileIndexRepo`：文件元信息仓储，提供登记、按指纹/URL/状态查询、状态更新、最佳 URL 解析、统计与清理
- 类型：`DB`、`LinkRecord`、`LinkStatus`

### 校验

- `verifyLink()`：校验单个链接（本地文件重算指纹 / data: URI 解析 / 远程 HEAD 探活）并更新记录
- `verifyStale()`：重新校验所有待校验或未验证的链接
- 类型：`VerifyResult`

### 时间工具

- `nowTicks()`、`ticksToDate()`、`ticksToIso()`、`ticksToMs()`、`TICKS_PER_MS`（100ns 时间刻度的生成与转换）

### 错误体系

- `FileIndexError` 及其子类 `UrlError`、`StorageError`、`VerifyError`

## 环境要求

- Node.js >= 22。

## 相关文档

- 包的设计背景与取舍见根目录 [`../adr/decisions/file-index-package-extraction.md`](../adr/decisions/file-index-package-extraction.md)。
- 数据库文件位置见根目录 [`../adr/decisions/unified-data-dir.md`](../adr/decisions/unified-data-dir.md)。