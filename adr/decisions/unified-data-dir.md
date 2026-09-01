# 统一数据目录：~/.img-data

## 背景

img-search 与 img-val 原先各自使用独立的数据目录：img-search 用 `~/.imgsearch/`，img-val 用 `~/.imgval/`。随着工具间共享数据的需求出现（`@llm-image/file-index` 的 `file-index.db` 需跨工具访问、分类标准可共用），分散的目录带来以下问题：

- **跨工具数据共享困难**：file-index 作为共享包，其数据库需被多个工具读写，但没有统一的定位基准。
- **备份与管理繁琐**：用户需分别备份 `~/.imgsearch/` 和 `~/.imgval/`，容易遗漏。
- **路径逻辑不一致**：各工具的 `paths.ts` 独立硬编码各自的家目录名，新增工具时需另起一个 `~/.img<tool>/`。

## 核心决策

将所有 img-* 工具的数据目录统一至 `~/.img-data/`。各工具的数据库与配置文件使用工具前缀命名，在统一目录内共存互不冲突。

- **统一家目录**：`getHomeDir()` 返回 `~/.img-data`（img-search 与 img-val 一致）。
- **工具前缀文件名**：数据库为 `imgval.db` / `imgsearch.db`；配置文件为 `imgval.toml` / `imgsearch.toml`（配置文件名在本次提交中由通用 `config.toml` 改为工具前缀名）。
- **bootstrap 参数**：函数参数由 `envDbDir` 重命名为 `baseDir`，语义从"工具专属数据库目录"变为"统一数据基目录"。
- **file-index.db** 共处同一目录，文件名互不冲突。

核心模块：img-search 与 img-val 的 `src/config/paths.ts`（家目录与配置文件路径）。

## 权衡分析

**方案 A：保留各工具独立目录**（`~/.imgsearch/`、`~/.imgval/`）

- 优点：完全隔离，无文件名冲突风险。
- 缺点：跨工具共享数据（file-index）需手动配置路径或硬编码跨目录引用；备份需多处操作。

**方案 B：统一至 `~/.img-data/`**（已选择）

- 优点：单一备份目标；file-index.db 天然共处，跨工具访问无需额外路径配置；新增工具只需加一个前缀文件名。
- 缺点：潜在文件名冲突（通过工具前缀命名规避）；所有工具的数据集中在同一目录，隔离性降低。

选择 B 的关键依据：工具间存在共享数据需求（file-index），统一目录是最简方案；工具前缀命名已足够避免文件冲突。

## 影响范围

- **Breaking Change（数据迁移）**：用户需将 `~/.imgval/` 与 `~/.imgsearch/` 中的数据迁移至 `~/.img-data/`，并按工具前缀重命名文件（如 `imgval.db` 保持原名；`config.toml` → `imgval.toml` / `imgsearch.toml`）。
- 环境变量 `IMGVAL_DB_DIR` / `IMGSEARCH_DB_DIR` 仍有效，指向统一目录（或自定义路径）。
- 新增工具（如 img-tagger 的设计文档中规划）将使用 `IMGDATA_DIR` 作为统一环境变量名，数据文件为 `imgtagger.db` / `imgtagger.toml`。
- 与配置文件迁移决策（见 [`config-toml-migration.md`](config-toml-migration.md)）协同：配置文件路径随数据目录统一而收敛。
