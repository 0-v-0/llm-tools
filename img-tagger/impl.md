# img-tagger — 实现说明

本文档描述 img-tagger 的内部结构、存储 schema、查询求值与测试计划（「怎么实现」）。设计决策与契约见 [DESIGN.md](DESIGN.md)。

## 1. 与 img-val 的复用关系

- **直接复用** `@llm-image/shared`：`processImage`、`hashBuffer`、`createProvider`、`openSqlite`、错误体系（`AppError` 层级）、LLM 类型。**已核实**：`openSqlite(dbPath, migrationsDir)` 自带迁移 runner（`shared/src/storage/sqlite.ts`），迁移机制可直接复用。
- **直接依赖** `@llm-image/file-index`：`blake3HexFile`（原始文件 BLAKE3 指纹）、`FileIndexRepo`（经 `blake3` 反查 url/type/size 等**文件元信息**）、`toFileUrl`/`mimeFromUrl`/`fileUrlToPath`（URL 与 MIME 工具）。本工具的 `image` 表仅保存 `blake3` 关联键，**不再保存** `url`/`format`/`size_bytes`——这些字段统一由 file-index 管理（§4），避免与 file-index 双写不一致；打标流程在入库前经 `blake3HexFile` 计算指纹，提交成功后 `register` 至 file-index（若未登记）。
- **移植/参照 img-val**：`config/env.ts`、`config/paths.ts`（改指向统一数据目录 `~/.img-data`、用 `IMGDATA_DIR` 定位 `imgtagger.toml` 与 `imgtagger.db`）、`standards/parser.ts`、`standards/loader.ts`（默认标准目录名为 `tag-spec`，与 DESIGN.md §4.2 的 `standardsDir` 默认值一致）、`llm/prompt.ts` 风格、`valuation/tool-flow.ts`（去掉 search 工具）、`valuation/exif.ts`、`cli/output/*`。
- **新增**：`query/`（表达式 lexer/parser/evaluate，img-val 的 search 前缀式查询不适用）、`tagging/conflict.ts`、标签管理仓储、`cli/check.ts`（健康检查）、`fileindex.ts`（file-index repo 单例与 url/type/size 反查，参照 img-search `fileindex.ts`）。

> **provider 层适配点（已核实）**：`createProvider` 的 OpenAI 分支支持 `response_format` 结构化输出（`strict: true`）、Anthropic 分支仅支持工具提取（忽略 `responseSchema`）。统一工具路径后，**唯一适配点**是 OpenAI 工具参数的 `strict: true` 结构化约束（shared `ToolFunctionDef` 暂无该字段，需在 shared 或 provider 层补充，使 OpenAI 工具返回同样受严格 schema 约束）；若 `createProvider` 不支持结构化工具调用，打标命令不可用。

## 2. 目录结构与模块划分

```
img-tagger/
├── package.json
├── tsconfig.json / tsconfig.build.json / vitest.config.ts
├── README.md
└── src/
    ├── index.ts                  # 入口，runCli(argv)
    ├── cli/
    │   ├── index.ts              # commander 程序：tag/search/tags/standards/images/check 命令注册
    │   ├── tag.ts                # 打标命令（顶层默认命令，单图/目录批量）
    │   ├── tag-edit.ts           # tag set/add/remove 修改标签命令
    │   ├── search.ts             # search 查询命令（装查询表达式解析器）
    │   ├── tags.ts               # tags list/create/show/delete 标签管理命令
    │   ├── standards.ts          # standards list/show 分类标准管理命令
    │   ├── images.ts             # images prune 清除无标签图片命令
    │   ├── check.ts              # check 数据库健康检查命令
    │   └── output/               # json.ts（统一 envelope）/ table.ts / progress.ts（沿用 img-val 风格）
    ├── config/
    │   ├── env.ts                # bootstrap 环境变量加载与校验（LLM 提供方 + IMGDATA_DIR，沿用 img-val env 模式）
    │   ├── config.ts             # imgtagger.toml 加载（TOML 解析）+ zod 校验（DESIGN.md §4.2）
    │   └── paths.ts              # 数据目录引导 bootstrap()（由 IMGDATA_DIR 定位 imgtagger.toml 与数据库）
    ├── standards/
    │   ├── parser.ts             # 标准解析（gray-matter + zod，沿用 img-val）
    │   ├── loader.ts             # 内置/文件系统标准加载
    │   └── builtin/
    │       └── default.md        # 内置通用分类标准
    ├── tagging/
    │   ├── prompt.ts             # 构建打标 prompt（标准 + 现有标签 + 规则）
    │   ├── tool-flow.ts          # LLM 工具调用循环 + 冲突解决重试 + failLogDir 失败日志写入（像素占位符）；维护当前上下文图片集合（get_exif 白名单）
    │   ├── tools.ts              # create_tag / get_exif / modify_image_tags / submit_tags 工具定义与执行
    │   ├── response-parser.ts    # submit_tags 结果解析与校验
    │   ├── conflict.ts           # 标签串冲突检测与冲突反馈消息构造
    │   └── exif.ts               # EXIF 提取（与 img-val 相同实现，exifr）
    ├── query/
    │   ├── lexer.ts              # 查询表达式词法分析
    │   ├── parser.ts             # 递归下降解析 → AST，含校验规则
    │   └── evaluate.ts           # AST → SQL WHERE（标签 EXISTS/NOT EXISTS）
    ├── fileindex.ts              # @llm-image/file-index repo 单例 + url/type/size 反查（参照 img-search）
    └── storage/
        ├── db.ts                 # openSqlite 单例 + 迁移 runner（沿用 img-val）
        ├── migrations/001_init.sql
        └── repository/
            ├── tag.ts            # 标签 CRUD、引用检查
            ├── image.ts          # 图片记录 upsert（含 blake3）、标签串维护
            └── search.ts         # 按标签查询、全量列出
```

## 3. 查询求值

AST 编译为对 `image` 的 SQL：

- 普通标签 `a`（无 `*`）：`EXISTS (SELECT 1 FROM image_tag it JOIN tag t ON t.id = it.tag_id AND t.name = ? AND it.image_id = image.id)`——**参数化精确匹配**（`=`）；
- 前缀标签 `a*`：`EXISTS (SELECT 1 ... WHERE t.name LIKE ? ESCAPE '\' COLLATE BINARY AND ...)`，参数为 `a%`；标签名中的 `%`、`_`、`\` 按字面转义。SQLite `LIKE` 对 ASCII 默认大小写不敏感，`COLLATE BINARY` 使前缀匹配与 DESIGN.md §2.3 规则 4「大小写敏感」一致（亦可于连接开启 `PRAGMA case_sensitive_like=ON`）；
- 反向叶子：上述子查询外层加 `NOT`；
- AND 组合（空格连接）：各叶子子查询以 `AND` 连接；
- OR 分支组合为 `(...) OR (...) OR ...`；
- **反向叶子需 `tag_string != ''`**：当查询含任意反向叶子（`-a`、`a|-b` 中的 `-b`、`(a|b) -c` 中的 `-c` 等）时，在**最外层 WHERE 整体包裹后追加** `(<既有 WHERE>) AND image.tag_string != ''`（而非在各反向子查询内部）。必须整体包裹：SQL 中 `AND` 优先级高于 `OR`，若在末尾裸追加，`-a|c` 这类反向叶子位于**非末尾**顶层 OR 分支的合法查询，其 `NOT EXISTS` 分支会命中 `tag_string = ''` 的未打标图片而误选。该 guard 避免把未打标图片一并选中（与"空标签串不算冲突"的语义对齐，DESIGN.md §9.2）。

结果按 `tagged_at` 倒序。

## 4. 数据库设计（SQLite）

数据库文件为 `<IMGDATA_DIR>/imgtagger.db`（默认 `~/.img-data/imgtagger.db`），与 img-val 的 `imgval.db`、img-search 的 `imgsearch.db`、file-index 的 `file-index.db` 共处同一目录，文件名互不冲突。WAL 模式开启（沿用 img-val）。**本工具不接管 file-index.db 的迁移与 schema**（经 `@llm-image/file-index` 的 `openFileIndexDb(getFileIndexDbPath(IMGDATA_DIR))` 只读打开）；数据写入仅在打标成功后经 `FileIndexRepo.register` 登记新条目。

`001_init.sql`：

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tag (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,   -- 全局唯一，大小写敏感
  description TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS image (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  image_hash  TEXT    NOT NULL UNIQUE,   -- SHA-256 处理后图片指纹（shared hashBuffer，处理后内容去重键）
  blake3      TEXT    NOT NULL,          -- 原始文件 BLAKE3 指纹
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  tag_string  TEXT    NOT NULL DEFAULT '', -- 标签串缓存（DESIGN.md §9.1）
  tagged_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS image_tag (
  image_id INTEGER NOT NULL REFERENCES image(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tag(id)   ON DELETE RESTRICT,
  PRIMARY KEY (image_id, tag_id)
);

CREATE INDEX idx_image_tag_tag      ON image_tag(tag_id);
CREATE INDEX idx_image_tag_string   ON image(tag_string) WHERE tag_string != '';
CREATE INDEX idx_image_blake3       ON image(blake3);
```

要点：

- `image_hash` 为处理后图片的唯一标识（同一文件重复打标走 upsert，不产生新记录）；`blake3` 为原始文件 BLAKE3 指纹，作为 `@llm-image/file-index` 的关联键——`url`/`type`(format)/`size` 等文件元信息统一由 file-index 管理（§1），本工具不再保存这些字段，避免双写不一致；file-index 的 url 为登记时快照，文件移动后可能失效，定位历史图片建议用 `--hash`（DESIGN.md §8.2）。
- `tag_string` 为缓存列，任何标签变更后由事务内重算写入，避免每次查询 join 全部标签。排序规则见 DESIGN.md §9.1。
- `image_tag.tag_id -> tag` 用 `RESTRICT`：**引用中的标签禁止删除**。
- **`image_tag` 索引**：仅需 `idx_image_tag_tag`（`tag_id` 不在主键前缀上，按标签反查图片必须用它）；按 `image_id` 的查询（清空重写、CASCADE 删除）由 `PRIMARY KEY (image_id, tag_id)` 最左前缀覆盖，**无需单独索引**。
- **`idx_image_blake3`**：按 `blake3` 反查 image（路径定位、file-index 元信息反查时使用）；`image_hash` 已是 `UNIQUE` 自带索引，无需单独建。
- **`idx_image_tag_string` 部分索引**（`WHERE tag_string != ''`）：`tag_string = ''` 的未完成打标记录不占索引条目，避免大量未打标图浪费空间。`tag_string` 字符数上限 ≈ 50 标签 × 64 字符 + 分隔空格（ASCII 约 3.2KB；含中文时 UTF-8 每字 3 字节，字节上限约 9.5KB），由 DESIGN.md §5.1 的标签长度与单图标签数上限天然约束，未加 DB 层 CHECK。
- **迁移机制**：启动时读取 `schema_version`，顺序执行 `src/storage/migrations/*.sql`（数字前缀，如 `001_init.sql`、`002_*.sql`），每个成功迁移写入版本记录；由 `db.ts` 复用 img-val 的迁移 runner 实现。后续变更以新增 `.sql` 文件演进，不修改历史迁移。
- **并发控制**：批量打标 `--concurrency N` 下，按 `image_hash` 分片把同一 hash 的全部操作排入同一 worker（如 `workerIndex = hash % N`），同一图片串行处理，规避跨 worker 竞态；不同 hash 并行。该静态分片只覆盖**当前打标图**——`modify_image_tags` 的目标图（冲突图）hash 不同、可能落在其它 worker，故**任何写路径**（打标提交、`modify_image_tags`、`tag set/add/remove`）在进入「冲突检测 → 写入 → 提交」临界区前，必须先获取其涉及的全部 `image_hash` 的**异步互斥锁**（per-hash mutex）：打标提交仅当前图；`modify_image_tags` 为当前图 + 目标图；`tag set/add/remove` 为操作图。多把锁按 `image_hash` 升序获取以规避死锁；锁持有期间临界区保持同步（无 `await`），退出临界区即释放。由此同一图片（无论作为打标图还是 `modify_image_tags` 目标）的全部写操作跨 worker **全局串行**，不同 hash 仍并行；静态分片退化为初始打标任务的路由优化，互斥职责由 per-hash 锁承担。`image_tag` 清空重写与 `tag_string` 重算在同一事务内完成；数据库以 **WAL journal 模式**打开并设置 `busy_timeout`（默认 5000ms）降低并发写冲突，SQLite 串行写仍为兜底。
- **冲突检测的原子性（代码级保证）**：v1 采用**单进程、共享数据库连接、事件循环内同步临界区**模型——所有会改变标签串的写路径必须满足「冲突检测 → 写入 → 提交」之间**无 `await`**（同一调用栈内完成）。因 Node 单线程事件循环，只要该临界区同步，则无论 `--concurrency N` 拆出多少个 worker、hash 如何分片，都不可能有另一笔写在两操作之间交错，「无冲突不变式」与 DESIGN.md §7.3.2 的「每次提交最多与 1 张图冲突」据此得到**代码级保证**；`busy_timeout` 与 WAL 仅作偶发锁竞争的兜底。**若未来扩展为多进程/多连接并发**，该同步临界区不再成立：冲突检测必须移入 `BEGIN IMMEDIATE` 写事务内，并在锁冲突经 `busy_timeout` 重试成功后在**事务内重新检测**再提交。v1 不实现多连接，此处仅声明约束。该同步临界区保证单次写操作内「检测 → 写入 → 提交」的原子性；**跨操作的同图串行**（如同一图片既被 worker A 作为打标图、又被 worker B 作为 `modify_image_tags` 目标）由上文 per-hash 互斥锁保证，二者层级不同、互补不替代。
- **无冲突不变式**：所有写操作提交前均执行冲突检测并在冲突时回滚，故库内任意时刻无冲突。若某次提交与多于一张图冲突，即不变量被破坏（异常，处理见 DESIGN.md §7.3.2 修复状态）。**启动时信任历史库保持该不变式，不做启动期全量校验**（需要时用 `imgtagger check` 手动校验）。

## 5. 测试计划

- `query/`: 词法/语法解析单测（优先级、括号、`*` 前缀、括号内 OR 禁反向、顶层 OR 分支允许反向、纯反向报错、`a b|c` 与 `-a b|c` 语义、长度上限）+ 求值为 SQL 的断言（参数化、LIKE 转义、无字符串拼接注入；含反向叶子时 WHERE 以 `(<既有 WHERE>) AND image.tag_string != ''` 整体包裹，并断言含反向叶子的查询（如 `-a|c`、`a|-b`）均不返回 `tag_string = ''` 的图片）。安全回归：恶意标签名/查询（含 `'`、`;`、`--`、`\`）不得执行非预期 SQL、不得绕过 LIKE 转义；大小写敏感回归（`a*` 不得匹配 `Apple`）。
- `tagging/`: prompt 构建、`submit_tags` 响应解析（合法/非法、`--verbose` 下必填 `description`、非 verbose 下 schema 不含该字段）、**两家 provider 统一经 `submit_tags` 工具提取、不启用 `response_format`**、标签名校验（全局硬规范 + `tagPattern` + 数量上限）、冲突检测与冲突反馈消息构造（单冲突/多冲突异常态）、工具执行（`create_tag` 去重/校验、`get_exif` 白名单越权拒绝、`modify_image_tags` 审批拒绝/`--yes`/标签存在性校验、冲突周期轮次计入 `maxToolRounds`）、**流级标签清理**（成功路径「建而未用」删除、失败/修复路径新建标签回收、零引用才删除、不误删并发已引用标签）。
- `storage/`: 标签 CRUD 与引用删除限制、图片 upsert（含 `blake3` 维护）与标签串重算、`tag set/add/remove` 冲突回滚、`tag set/add` 的 `--standard` 解析与 `maxTags` 上限（缺省标准默认 50）、`images prune`（匹配 `tag_string=''`、CASCADE 清 `image_tag`、孤立 tag 保留、`--dry-run`/`--yes`/非 TTY 行为）、迁移 runner 顺序执行。
- `fileindex/`: `blake3HexFile` 计算与 file-index `register`/`findByBlake3`/`findByUrl` 联动；image 表只存 `blake3`，`url`/`type`/`size` 经 file-index 反查填充（命中/未命中、文件已移动时按 `findByUrl` 取旧 `blake3` 再匹配 image）。
- `check/`: 五项检查各自命中/未命中、缓存漂移构造（手工改 `tag_string`）、只读不改库、退出码 0/5、`--format json` 结构。
- `concurrency/`: `--concurrency N` 批量打标——同一 `image_hash` 分片串行（同一图片不被并发处理）、不同 hash 并行、`image_tag` 清空重写 + `tag_string` 重算的事务原子性（异常时回滚不留半状态）、单图失败不影响其它图片（失败隔离）；并发下无 `SQLITE_BUSY` 报错（WAL + `busy_timeout`）；`--concurrency 1`（串行）与默认并发结果同构；**跨 worker 同图串行**——同一图片分别作为打标图与 `modify_image_tags` 目标被两个 worker 同时写入时，per-hash 互斥锁保证结果与串行执行一致（无交错、无丢失更新）。
- `fail-log/`: 设置 `failLogDir` 时失败图写入完整请求 JSON（含 prompt、消息历史、工具轨迹、错误信息），文件名不冲突；未设置时不产生日志；**消息历史中的图片块以占位符替代、不含任何 base64 像素（断言该规则，与 img-val 现实现的差异）**；**默认不记录 EXIF（含 GPS），`failLogIncludeExif = true` 时记录**；`--mode skip` 重跑只处理失败/未打标图片；非 LLM 操作（`tags delete`、`images prune`、`tag set` 等）与 `--dry-run` 下 LLM 失败均不写入 failLogDir。
- `dry-run/`: 虚拟写入层（overlay）行为——`create_tag` 新建标签对同流程后续 `submit_tags` 存在性校验可见；`modify_image_tags` 模拟批准虚拟执行；流程结束 overlay 丢弃、数据库零改动；`--concurrency N` 下跨 worker 虚拟冲突隔离（漏报为预期）。
- `config/`: imgtagger.toml 解析与 zod 校验（缺省默认、字段非法报错退出、`IMGDATA_DIR` 定位）、配置文件不存在时静默使用默认值；无同名环境变量残留。
- `interactive/`: 交互确认（`images prune` 确认、`modify_image_tags` 审批、非 TTY 报错）——确认逻辑实现为可注入函数，测试注入 mock 返回值；非 TTY 分支通过 mock `process.stdin.isTTY` 或注入的 TTY 探针断言；`modify_image_tags` 获批即持久化断言（获批修改真实提交，本图后续失败不回滚目标图修改）。
- 展示顺序：`tag_string` 恒为字节序（存储不变）；表格输出/冲突反馈按 locale 排序（数字自然序、大小写不敏感、中文序、同序按 `created_at` 稳定）；`--format json` 输出不含展示序，仅 `tag_string`。
- 端到端冒烟：fixtures 图片（沿用 img-val fixtures）打标 → 查询 → 修改 → 冲突场景（含 `--dry-run` 无副作用断言）。
