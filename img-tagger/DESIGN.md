# img-tagger — 图片智能打标器 设计文档

基于 LLM 的图片智能打标 CLI 工具。给定图片与可自定义的分类标准，调用多模态 LLM 为图片贴标签（打标）；支持按标签查询图片、修改图片标签、标签管理。架构沿用仓库统一约定：commander CLI、zod 校验、SQLite 存储、共享基础设施。

## 1. 目标与范围

### 1.1 功能范围

| 子命令 | 名称 | 是否调用 LLM |
|--------|------|--------------|
| `imgtagger <path|dir>` | 图片分类（打标） | 是（必须） |
| `imgtagger search [query]` | 按标签查询图片 | 否 |
| `imgtagger tag set/add/remove` | 修改图片标签 | 否 |
| `imgtagger tags list/create/show/delete` | 标签管理 | 否 |
| `imgtagger standards list/show` | 分类标准管理 | 否 |
| `imgtagger images prune` | 清除无标签图片 | 否 |
| `imgtagger check` | 数据库健康检查（只读） | 否 |

### 1.2 核心规则（需求要点）

- 标签**先创建后使用**（见 §5.3）；每个标签包含**标签描述**。
- 标签**不能包含空格**；另有全局字符规范与分类标准中的附加命名规范（见 §5）。
- 图片的全部标签构成**标签串**（定义见 §9.1）。
- **冲突**：见 §9.2；冲突**可通过新增标签或修改已有图片的标签解决**：
  1. **打标路径**（调 LLM）：冲突信息反馈 LLM，LLM 可新增区分性标签后重新提交，或调用 `modify_image_tags` 工具修改冲突图片的标签（默认需用户批准，拒绝原因反馈 LLM，见 §7.3）；
  2. **手动路径**（`tag set/add`，不调 LLM）：冲突直接报错，不进入解决协议。
- 打标**必须启用 LLM 工具调用**（`create_tag`、`get_exif`、`modify_image_tags`、`submit_tags`）；所选 provider 支持结构化工具调用，不支持则打标命令直接报错退出。

  > **设计权衡**：强制工具调用是显式取舍——以放弃不支持结构化工具调用的 provider 为代价，换取「标签先创建后使用」与冲突解决协议（§7.3）得以成立。

- 分类标准可自定义（Markdown + YAML frontmatter）。

### 1.3 术语表

| 术语 | 简略定义 | 出处 |
|------|----------|------|
| **标签串**（`tag_string`） | 图片全部标签名按存储序连接所得字符串；空标签集为 `''` | §9.1 |
| **冲突** | 两条不同图片记录的 `tag_string` 非空且相等 | §9.2 |
| **未完成打标** | `tag_string = ''` 的图片；`--mode skip` 重跑会重新打标 | §9.2 |
| **打标路径** | 调 LLM 的打标流程（顶层默认命令），冲突进入冲突解决协议自动处理 | §7 |
| **手动路径** | 不调 LLM 的命令（`tag`/`tags` 等），冲突直接报错、不进入解决协议 | |
| **先创建后使用** | 打标仅能使用已存在标签，或经 `create_tag` 新建；手动与 LLM 路径走同一校验 | §5.3 |
| **无冲突不变式** | 库中任意时刻不存在 `tag_string` 相同的两条不同图片 | §7.3 |
| **存储序**（字节序） | `tag_string`、冲突判定、SQL 查询所采用的 UTF-8 字节升序；大小写敏感、跨平台确定 | §9.1 |
| **展示序**（locale 序） | 人类可读输出的排序（`Intl.Collator`：数字自然序、大小写不敏感、中文拼音序）；不进入 JSON 输出 | §9.1 |
| **全局硬性规范** | 标签名的程序校验硬约束（非空、长度 1–64、禁空白、禁保留字符等），违反即报错/反馈重试 | §5.1 |
| **附加命名规范** | 分类标准为标签名附加的自然语言软约束与可选 `tagPattern` 正则（可程序校验） | §5.2 |
| **上下文图片集合** | 当前打标流程可触达的图片集合（当前打标图 + 冲突反馈附带的冲突图） | §7.3 |
| **冲突解决周期** | 自首次产生冲突的 `submit_tags` 起，至成功提交或任一专项额度耗尽止；期间专项上限独立计数 | §7.3 |
| **修复状态** | 检测到多图冲突等不变量破坏时进入的中止打标异常状态 | §7.3 |
| **写操作串行保证** | 同一图片的全部写操作（打标提交、标签修改等）跨并发 worker 全局串行，保证无交错写 | §7.3 |
| **统一 envelope** | `--format json` 的输出结构 `{ ok, data \| error }` 与退出码约定 | §8.3 |
| **图片对象** | JSON 输出的图片记录形状：`{ path, image_hash, blake3, tag_string, format, width, height, size_bytes, tagged_at }`；`tag_string` 恒为存储序 | §8.3 |
| **file-index** | 共享文件索引库：以原始文件 BLAKE3 指纹为主键、`url`（与图片对象的 `path` 同指文件路径）为次级索引，双向登记/反查 `url`/`type`/`size` 等文件元信息；本工具不保存这些字段，打标成功后登记新条目 | §8.1、§8.2 |

## 2. 查询表达式语法

### 2.1 语法

```
expr    := orExpr
orExpr  := andExpr ( '|' andExpr )*        # 反向允许出现在 OR 分支的 AND 因子中；仅禁止括号内 OR 含反向（§2.3 规则 2）
andExpr := factor ( whitespace factor )*   # 隐式 AND，优先级高于 |
factor  := ('-'? tagName '*'?) | '(' expr ')'   # - 为反向查找；'*' 后缀通配符（实现前缀匹配，不能单独出现）；tagName 词法不含 '*'，故 '*' 仅作后缀通配符
tagName := 不含空白与 | ( ) * 的字符序列，且不以 `-` 开头（长度 1–64；叶子开头的 `-` 解析为反向操作符，标签名内/非首字符的 `-` 属于标签名本身，含 `-` 的标签如 `nature-photo` 可正常查询）
```

括号 `()` 改变优先级；`*` 仅支持**前缀匹配**（`a*` 匹配以 `a` 开头的标签名，`-a*` 反向前缀匹配）。

**词法规则**：`-` 仅当紧邻前驱为空白、`(`、`|` 或串首时解析为反向操作符，其余情况（位于 token 内部）属于标签名本身——`nature-photo` 是单个标签；`a -b` 切为 `a` 与 `-b`；`-a-b` 为标签 `a-b` 的反向。`-` 仅绑定标签名、**不支持对括号分组取反**（`-(a|b)` 为语法错误）；标签名可以 `-` 结尾（如 `a-`，§5.1 允许），词法上归为标签名本身。

> **无歧义前提**：`tagName` 不含 `*`（全局禁止），故 `*` 仅作紧随其后的前缀通配操作符，不会与标签名内的字面 `*` 混淆。

### 2.2 语义

| 表达式 | 语义 |
|--------|------|
| `a` | 含标签 `a` |
| `-a` | 不含标签 `a`（反向） |
| `a b` | 同时含 `a` 与 `b`（AND） |
| `a b|c` | `(a AND b) OR c`（**AND 优先级高于 OR**） |
| `-a b|c` | `(NOT a AND b) OR c`（反向叶子可作 OR 分支的 AND 因子） |
| `a|-b` | `a OR NOT b` |
| `(a|b) c` | `(a OR b) AND c` |
| `a*` | 含任一以 `a` 开头的标签 |
| `-a*` | 不含任何以 `a` 开头的标签 |

### 2.3 校验规则

1. **纯反向整体非法**：整个表达式必须至少包含一个正向查找项，否则报错（`-a`、`-a -b`、`-a*` 均报错）。
2. **括号内 OR 禁反向**：反向叶子可出现在任意 AND 因子位置——顶层（`a -b`、`a -b c`）、OR 分支的 AND 因子（`-a b|c` = `(-a AND b) OR c`、`a|-b` = `a OR -b`）、括号纯 AND 组（`(-a b)`）、与括号 OR 因子并列（`(a|b) -c`）。仅**括号分组内含 `|` 时**不得有反向因子（`(a|-b)`、`(-a|b)`、`(a|-b) c` 报错）。
3. `*` 必须跟在标签名后（不能裸 `*`、不能 `(a b)*`）。
4. 标签名匹配大小写敏感。
5. `tagName` 长度 ≤64，超长报错。

## 3. 失败处理与日志

### 3.1 批处理语义

- 批量模式下单图失败**不影响其它图片**：失败图记录后跳过，继续处理剩余图片；全部结束后汇总报告。
- 失败图分为两类：
  - **打标失败**（LLM 错误、工具轮次耗尽、冲突解决超限等）：该图不写库，计入失败汇总；流程内经 `create_tag` 新建的标签由流级清理（§7.2）回收，不残留孤儿标签。
  - **单图前置校验失败**（文件缺失、解码失败、越界尺寸等）：同前，计入失败汇总。
- 重跑补失败图：`--mode skip`（默认）下，已成功图片（`image_hash` 存在且 `tag_string` 非空）被跳过，只处理未完成/失败图片；失败图不写库，故重跑即补。

### 3.2 汇总报告

- 批量结束输出汇总：成功数、失败数、跳过数（`--mode skip` 下已打标图片）；失败数 > 0 时非零退出码——按错误类别优先级取值：同批含多类错误时取较高优先级（存储 5 > 图片 4 > 泛型/LLM/校验 1，见 §8.3），单一类别则取对应码。
- 逐条失败明细（路径、错误类别、简要原因）默认打印到 stderr；`--verbose` 下打印完整错误栈。

### 3.3 failLogDir

- `failLogDir`（默认空串 = 禁用）为失败日志目录；启用时每张失败图写入一个完整请求 JSON 文件。
- **范围**：仅记录 LLM 打标流程失败；`images prune`、`tags delete`、`tag set/add/remove`、`search` 等非 LLM 操作失败**不写入**（直接报错退出）；`--dry-run` 下 LLM 打标失败同样不写入（保持无副作用）。**图片块一律排除**：消息历史中的 `image_url` 图片块（含原始 prompt 与后续用户消息中的 base64 像素数据）不写入日志，统一替换为占位符（如 `[图片内容省略]`）；该规则不受 `failLogIncludeExif` 影响（该配置只决定 EXIF 是否记录）。**本工具刻意收紧隐私边界——图片像素内容在任何情况下不入日志。**
- **目录**：启用时父目录不存在则自动创建；创建失败降级为 stderr 告警，不影响打标流程本身。
- 文件内容保留**完整轨迹**供离线回放/调试：原始 prompt、消息历史（含工具调用与结果）、工具调用序列、失败错误码与消息、失败阶段标记、图片路径与 hash、EXIF（若 `failLogIncludeExif` 启用）。
- 文件名：`fail-<图片 hash>-<unix 毫秒>-<pid>.json`；多个失败图各写独立文件，不互相覆盖。

## 4. 环境变量与配置文件

### 4.1 环境变量

LLM 提供方与 bootstrap 路径使用环境变量；其余可调项见配置文件（§4.2）。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_PROVIDER` | `openai` | `openai` / `anthropic` |
| `OPENAI_API_BASE` / `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_VISION_DETAIL` |  | OpenAI 兼容配置 |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` |  | Anthropic 配置 |
| `IMGDATA_DIR` | `~/.img-data` | 统一数据目录（三工具共用），bootstrap 用，配置文件的定位依据 |

### 4.2 配置文件 imgtagger.toml

- **路径**：`<IMGDATA_DIR>/imgtagger.toml`（默认 `~/.img-data/imgtagger.toml`）；文件不存在时全部使用默认值，不报错。
- 经 TOML 解析后 zod 校验；字段类型非法 → 报错退出。**配置文件是这些可调项的唯一来源**（不提供对应环境变量）。校验要点：`failLogDir` 为非 nullable 字符串，默认空串，运行时以 `failLogDir.length > 0` 判定启用（§3.3）。
- 键值：

| 配置项 | 类型 / 默认 | 说明 |
|--------|-------------|------|
| `standardsDir` | string, `~/.img-data/tag-spec` | 分类标准目录 |
| `maxImageDimension` | int, `1568` | 送 LLM 前最长边限制 |
| `maxToolRounds` | int, `6` | 工具循环上限 |
| `tagConflictRetries` | int, `2` | LLM 工具反馈重试上限 |
| `modifyRejectLimit` | int, `1` | `modify_image_tags` 用户连续拒绝上限 |
| `createTagPerCycle` | int, `5` | 单冲突解决周期内 `create_tag` **成功新建**标签数上限 |
| `failLogDir` | string, `""` | 失败日志目录；空串禁用，非空启用（§3.3） |
| `tagListCap` | int, `500` | 已有标签提示列表上限，超过则省略描述 |
| `failLogIncludeExif` | bool, `false` | 失败日志是否记录 EXIF；默认不记录（含 GPS），见 §3.3 |

示例：

```toml
standardsDir = "~/.img-data/tag-spec"
maxImageDimension = 1568
maxToolRounds = 6
tagConflictRetries = 2
modifyRejectLimit = 1
createTagPerCycle = 5
failLogDir = ""
failLogIncludeExif = false
tagListCap = 500
```

## 5. 标签命名规范

### 5.1 全局硬性规范（程序校验，违反即报错）

标签名必须同时满足：

1. 非空，长度 1–64。
2. 不能包含空白字符（空格、制表符等）——标签串以空格连接的前提。
3. 不能包含查询语法保留字符：`|` `(` `)` `*`（与 §2.1 标签名词法共用同一保留字符集，保证任何合法标签名均可无歧义构造查询）。
4. 必须以字母（Unicode）、数字或 `_` 开头——蕴含"不能以 `-` 开头"。
5. 仅允许 Unicode 字母、数字、`_`、`-`、中文等（宽松默认，允许中文）。
6. 单一图片标签数上限：默认 50（见 §6）。

标签名可含 `%`、`_`（不禁止）；查询时普通项按精确匹配、通配项按转义后 LIKE 处理，故无歧义。

### 5.2 分类标准中的附加命名规范（软约束）

分类标准文件正文中以自然语言描述附加命名规范（如"标签必须含主题前缀 `nature-`"、"长度不超过 12"、"必须为中文"）；亦可选用 frontmatter 字段 `tagPattern`（正则）将其程序化校验。

- 自然语言部分：作为系统提示（覆盖全部决策点，含 `submit_tags`）与 `create_tag` 工具描述的一部分提供给 LLM，由 LLM 自觉遵守，不程序校验。
- `tagPattern` 部分：自 frontmatter 读取正则，在 §5.3 校验流程中追加为硬性环节。
- **规范篇幅**：标准作者应将自然语言附加规范保持精简（建议 ≤ 2 千字）——该段落会整体进入 `create_tag` 工具描述与系统提示；设计上不提供运行时截断，避免 LLM 因截断误解规范。

### 5.3 创建校验流程

`tags create`、`create_tag` 工具、`tag add/set` 三处均调用同一校验流程。固定按下列顺序执行，**任一失败环节不通过即终止**：手动路径（`tags create`/`tag add/set`）直接报错并停止；LLM 路径（`create_tag`）构造反馈消息要求 LLM 重试：

1. **查重**：已存在 → 返回既有标签（手动路径报"已存在"）。查重优先于后续格式校验是有意为之：标签一旦存在即不再需要格式校验（存在即事实，哪怕是历史数据遗留），故「重复且非法名」一律按「已存在」处理。
2. **全局硬规范**：不通过 → 报错/反馈重试。
3. **`tagPattern`**（标准含该字段时）：JS `RegExp` 锚定 `^...$`，不通过 → 报错/反馈重试。
4. **软约束（仅 LLM 路径）**：不程序校验、不构成失败环节；手动路径至第 3 步即止。

## 6. 分类标准格式

YAML frontmatter + Markdown 正文（gray-matter 解析 + zod 校验），放在 `standardsDir`（见 §4.2）。

frontmatter 字段：

```yml
---
name: default            # 必填，唯一
description: 通用图片分类标准
version: "1.0.0"
tags: [general]          # 可选：仅供用户按类别整理标准使用，不发送给 LLM
tagPattern: ^nature-     # 可选：标签名正则（程序校验，见 §5.2）
maxTags: 30              # 可选：单图标签数硬上限（覆盖 §5.1 默认值）
---
```

> **注**：`tags` 字段仅用于用户在本地按类别组织标准文件，**不会出现在发送给 LLM 的 prompt/工具描述中**；标签库为全局且不与标准关联，故 `tags list` 不提供按标准过滤。

正文包含：

1. **打标维度说明**：类别体系/打标思路（如"主体、场景、风格、技术参数、情绪"）。
2. **标签命名规范**（附加软约束 / `tagPattern`）。
3. **标签使用规则**（如"每图 2–6 个标签"、"优先复用已有标签"）。

内置标准 `default.md`：通用摄影/图片分类。

- **加载时机**：标准文件在每次打标任务开始时一次性加载并快照，任务期间不重新读取；修改标准文件需重启任务。

## 7. LLM 打标流程

### 7.1 工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `create_tag` | `name`、`description` | 新增标签；执行校验（含 `tagPattern`，流程见 §5.3）；重复名返回既有标签 `{ id, name, description }`（供 LLM 判断是否复用，不报错） |
| `get_exif` | `path`（必填） | 图片 EXIF（相机、镜头、拍摄参数、日期、GPS），供技术类标签参考；`path` **必须**为**上下文图片集合**中的路径；集合外路径 → 报错 `EXIF_PATH_NOT_ALLOWED`，不读取；`path` 参数缺失属工具调用参数校验失败，反馈一般校验错误 |
| `modify_image_tags` | `image`（路径或 hash）、`tags: string[]` | 修改**已有图片**的标签集合（整体替换），用于解决冲突；`image` 必须为上下文图片集合中的图片，集合外 → `MODIFY_PATH_NOT_ALLOWED`；`tags` 必须已存在——含不存在标签 → 报错并列出缺失清单，提示先用 `create_tag` 新建（本工具不代建）；执行前默认需用户批准，拒绝时把拒绝原因反馈给 LLM（见 §7.3.4） |
| `submit_tags` | `tags: string[]`、`description?` | 提交最终标签结果（约束解码用）；`description` 不入库、不影响打标结果；Schema 是否含 `description` 由 `--verbose` 决定（见 §8.1） |

> **设计权衡**：两家 provider 统一走工具调用——OpenAI API 不允许同一请求同时携带 `tools` 与 `response_format=json_schema`，而打标全程必须携带工具，故 OpenAI 与 Anthropic 收敛为同一路径。`submit_tags` 作为工具定义提供给 LLM，最终结果由工具参数提取。OpenAI 侧如需严格结构约束，在工具 `parameters` 上加 `strict: true`。

**工具错误结果**统一为 `{ ok: false, error: { code, message } }` 反馈给 LLM。`get_exif` 的 `code` 区分：`EXIF_PATH_NOT_ALLOWED`（集合外路径，越权）、`EXIF_PATH_NOT_FOUND`（集合内但文件不存在）、`EXIF_READ_FAILED`（读取/解析失败），使 LLM 能分辨"不能读"与"不存在"。

### 7.2 打标单轮流程

1. 加载标准（`--standard`，默认内置 default）；计算原始文件 BLAKE3 指纹与处理后图片指纹 `image_hash`（`blake3` 用于文件关联与路径定位，`image_hash` 用于处理后内容去重）；`skip` 模式去重。
2. 图片预处理（缩放）→ 构建 prompt：标准正文 + 附加命名规范 + 全部已有标签列表（名称+描述）+ 规则（每图标签数量、优先复用已有标签、新建标签仅在无法表达时且每次 ≤3 个）。"每次 ≤3 个"为**提示级软约束**（不程序校验），与 §7.3.7 的 `createTagPerCycle`（硬约束）分层：前者约束单次提交新增标签数，后者约束整个冲突解决周期。已有标签超过 `tagListCap` 时仅发送名称列表（省略描述）。
3. 工具循环（`maxToolRounds`，默认 6，见 §4.2）：`get_exif` / `create_tag` 可被多次调用，最终必须调用 `submit_tags`。**轮次耗尽时中止该图打标并报错**（"工具轮次耗尽：第 N 轮仍未完成 `submit_tags`，已中止该图打标"），不静默截断；该图计入 `failLogDir`。
4. 校验 `submit_tags` 结果：
   - 引用的标签必须**已存在**（LLM 漏建）→ 把"不存在标签清单"反馈给 LLM 重试（计入工具轮次）。
   - 标签名按 §5.3 校验流程（全局硬规范 + `tagPattern`），标签数不超 `maxTags`（见 §6），失败同样反馈重试。
5. **流级标签清理（flow-scoped tag cleanup）**：流程自进入工具循环起记录本次经 `create_tag` **成功新建**的标签集合；流程结束时（成功提交、任一上限耗尽中止、修复状态退出）执行清理——仅删除该集合中**当前零引用**的标签：成功路径回收「建而未用」（如新建 3 只用 2），失败/中止路径回收未随提交入库的全部新建标签，避免残留孤儿标签（与 §3.1「该图不写库」语义一致）。引用检查与删除在同一事务内完成：即使其它流程在清理后引用该标签，其会在自身事务内重新校验并获「不存在」反馈、可经 `create_tag` 重建，无一致性风险。该清理与 §7.3.7 的 `createTagPerCycle` 计数相互独立。

### 7.3 冲突解决协议（LLM 自动解决）

**冲突解决周期**：定义见 §1.3。周期内 §7.3.6 两类重试上限与 §7.3.7 `create_tag` 新建数上限独立计数；周期终结后（若后续提交再冲突）进入新周期、重新计数。**冲突期间新增的工具轮次（每次冲突反馈后 LLM 的再调用）同样计入全局 `maxToolRounds`**；§7.3.6 两类额度与 §7.3.7 的 `createTagPerCycle` 是在此之上的**专项上限**，任一先耗尽即中止该图打标——总轮次以 `maxToolRounds` 封顶，专项额度不增加全局轮次。

1. 校验通过后计算 `tag_string`，基于当前库执行冲突检测。**上下文图片集合**在进入工具循环前即含目标图（`get_exif` 可查询自身）。
2. 冲突时构建反馈消息：冲突 `tag_string`、冲突图片**内容**（缩放后随消息发送）及路径，提示"必须解决冲突后方可提交，不得与现有图片标签串相同"。该图随即**追加**入上下文图片集合，此后 `get_exif` 与 `modify_image_tags` 可对其操作；每轮冲突至多追加 1 张，故集合上界为 **1 + 冲突次数**（冲突次数受 §7.3.6 上限约束），无无限增长路径。集合生命周期与单张图片的整个打标流程一致：流程开始创建、成功提交或中止时释放，跨冲突周期不清除，保证 LLM 对历史冲突图上下文的连续性。
   **冲突数量**：库保持无冲突不变式，故每次提交最多与 **1** 张图冲突，发送该图内容即可。若一次提交与多张图冲突（>1），属**不可达分支**（不变式已被破坏，多为历史数据问题）：立即中止该图打标并进入**修复状态**——**向 stderr 输出告警与诊断日志**「数据库处于异常状态：存在标签串相同的多张图片」，附冲突涉及的图片明细（`path`/`image_hash`/`tag_string`）供定位排查；**不向 LLM 发送冲突图片、不做自动解决**，并**重置全部重试计数器**（`tagConflictRetries`/`modifyRejectLimit`/`createTagPerCycle`）；提示先运行 `imgtagger check` 定位，再以 `images prune`、`tag set` 或 `tags delete` 人工修复。批量模式下该图计入失败汇总、继续处理其它图；该状态非 LLM 打标失败，**仅通过 stderr 告警、不写入 failLogDir**（§3.3）。
3. 将此消息作为新一轮用户消息追加，LLM 通过以下任意方式解决：
   a. `create_tag` 新建区分性标签后重新 `submit_tags`（推荐，不改动他人图片）；该路径受 §7.3.7 `createTagPerCycle` 上限约束；
   b. 调用 `modify_image_tags` 修改冲突已有图片的标签集合，使各图片标签串互不相同，再重新 `submit_tags`。（该工具只改动标签集合，不涉及文件内容，故目标图片 `image_hash` 不变。）
4. **`modify_image_tags` 审批**：工具执行前弹出交互确认（显示目标图片路径、原标签串、新标签串，`y/N`）。默认拒绝——拒绝时不执行修改，并把拒绝原因构造为工具执行结果反馈给 LLM（"用户拒绝了该修改：<原因>"），LLM 可换用 `create_tag` 方案或提出新的修改方案；非 TTY 环境（无交互）同样视为拒绝后继续流程（与 `images prune` 非 TTY 直接报错退出不同：审批拒绝只是「不执行该工具」，流程仍可经 `create_tag` 等路径继续）。`--yes` 跳过确认直接执行。审批不消耗工具轮次；拒绝次数计入 §7.3.6 的 `modifyRejectLimit`。**获批即持久化**：获批的修改真实提交，不随本图后续失败（轮次/额度耗尽、修复状态）回滚；审批即授权持久化变更，确认文案应提示目标图片将被实际修改。
5. 工具执行校验：`modify_image_tags` 的 `tags` 存在性校验见 §7.1 工具表；通过后重算目标图片 `tag_string`，若与其它图片也冲突则同样构造反馈要求继续解决。`create_tag`/`submit_tags` 的校验同 §7.2 步骤 4。
6. **两类重试上限**，各自计数、互不影响：
   - **LLM 工具反馈重试**（`tagConflictRetries`，默认 2，见 §4.2）：一次冲突解决周期内，`create_tag`、`submit_tags` 反馈失败（含校验失败、不存在标签、数量超限、`tagPattern` 不匹配）共享该额度，**累计**计数；累加达上限 → 中止该图打标。
   - **用户连续拒绝**（`modifyRejectLimit`，默认 1，见 §4.2）：`modify_image_tags` 被用户**连续拒绝**的次数——LLM 每调用一次 `modify_image_tags` 若被拒则计数 +1，**任一次获批立即清零**，此后下一次拒绝重新从 1 起计；期间的 `create_tag`/`submit_tags` 尝试**不**清零该计数。累加达上限 → 中止该图打标，提示用户改用 `tag set` 手动解决。例：周期内 `modify→拒`、`create→submit（仍冲突）`、`modify→拒` → 计数 2 达上限中止；若第二次 `modify→批` → 清零，之后 `modify→拒` 重新计 1。
   任一额度耗尽即终止该图打标，报错（批量模式下记录失败并继续其它图）。
7. **`create_tag` 周期上限**（`createTagPerCycle`，默认 5，见 §4.2）：一次冲突解决周期内 `create_tag` **成功新建标签**的累计次数上限——计数单位为**成功新建数**而非工具调用次数：每次新建成功 +1；命中已存在标签（重复名返回既有标签）或校验失败**不计**入该上限。超过则本次调用报错反馈 LLM（"本周期内 `create_tag` 次数已达上限，请改用 `modify_image_tags` 或提出新的解决思路"），与 §7.3.6 两类额度独立计数。防止 LLM 以无意义新增标签规避修改他人图片。
8. 无冲突 → 在事务内写入图片记录与标签关联、重算 `tag_string` 并提交；提交成功后登记文件元信息至 file-index（若未登记）。

## 8. CLI 命令

### 8.1 `imgtagger <path|dir>`（顶层默认命令，打标）

```
imgtagger <path>  [--standard <name|path>] [--dry-run] [--yes] [--format text|json] [--verbose]
imgtagger <dir>   [--standard <name|path>] [--recursive] [--concurrency N]
                  [--include <glob>] [--progress] [--mode <skip|full>]
                  [--dry-run] [--yes]
                  [--format text|json] [--verbose]
```

- 自动识别：文件→单图，目录→批量。
- `--mode`（**仅目录批量模式可用**）：`skip`（默认，只处理未完成/失败图片，行为见 §3.1）、`full`（全量重新打标，覆盖原 `tag_string`；**覆盖已打标图片前默认交互确认**，`--yes` 跳过；**建议先备份数据库**，中途失败后旧标签不可恢复）。文件路径由 file-index 统一管理（本工具不保存 `url`）。
- `--dry-run`：跑完整打标流程与冲突解决协议（§7.3），**不写数据库**。**虚拟写入层（in-memory overlay）**：期间全部虚拟写入——`create_tag` 新建标签、`modify_image_tags` 修改、图片记录写入——落在内存 overlay；读路径先查 overlay 再查库，故后续 `submit_tags` 的标签存在性校验与冲突检测（§7.2 步骤 4、§7.3 步骤 1）均基于「即将写入的虚拟结果」进行。`modify_image_tags` 视为**模拟批准**并虚拟执行，以完整演练冲突解决协议；流程结束丢弃 overlay、数据库零改动。**会消耗 LLM 调用与 token（与真实运行相同）**，但无任何副作用：不写库、不写 `failLogDir`（§3.3）、不弹审批。`--format json` 下输出含冲突报告。**并发提示**：`--concurrency N` 下每个 worker 独立 overlay，跨 worker 的虚拟冲突互不可见、可能漏报；需要精确的批内冲突报告时，dry-run 建议以 `--concurrency 1` 运行。
- `--yes`：跳过所有交互确认（含 `modify_image_tags` 审批、覆盖提示等），见 §7.3.4。**注意**：`--yes` 授予自动修改他人图片标签的权限且无人工把关，自动化/CI 场景请确认无误后再启用。
- `--concurrency`：并发通过 hash 分片保证同一图片不并发处理。
- `--recursive`：目录模式下递归处理子目录；`--include <glob>`：仅处理匹配 glob 的文件；`--progress`：显示批量处理进度。
- 打标必须调用 LLM 且启用工具调用（见 §1.2）。
- 图片送入前经图片预处理缩放（`maxImageDimension`，见 §4.2）。
- `--verbose`：除常规日志外，要求 LLM 结果附带 `submit_tags.description`（调试信息）并打印；非 verbose 时不索取 `description`，且它不出现在系统提示/工具定义/结果 schema、不进入输出（见 §7.1）。
- **失败处理**：批量模式下单图失败不影响其它图片；失败详情按 §3.3 记录（`failLogDir`，见 §4.2）。
- **`--format json` 的 `data` 结构**：
  - 单图：图片对象（形状见 §1.3）；失败时 `ok: false` 且 `error` 为失败原因（退出码非零）。
  - 批量：`{ summary: { total, succeeded, failed, skipped }, items: [图片对象 | { path, error: { code, message } }] }`；`ok` 恒为 `true`（流程完成），失败数 >0 时退出码非零（§3.2）。`--dry-run` 时每项附 `conflicts`（潜在冲突图片路径列表）。

### 8.2 `imgtagger tag set/add/remove`（修改图片标签，不调用 LLM）

```
imgtagger tag set <path> [tag...] [--hash <image_hash>] [--standard <name|path>] [--format text|json]    # 整体替换：清空现有标签后再设置（不带 tag = 清空）
imgtagger tag add <path> <tag>... [--hash <image_hash>] [--standard <name|path>] [--format text|json]    # 追加（标签必须已存在，否则报错提示先用 tags create）
imgtagger tag remove <path> <tag>... [--hash <image_hash>] [--format text|json]     # 移除；移除后标签串为空则不参与冲突
```

- 按路径定位图片：`--hash` 优先（按 `image_hash` 精确匹配）；否则路径 → 文件存在 → 计算原始文件 BLAKE3 指纹并匹配；文件不存在 → 经 file-index 按路径取已登记的 BLAKE3 指纹再匹配（file-index 的 url 为入库时快照，文件移动后可能失效，建议用 `--hash`）；均无 → 报错，文案提示「若文件已移动，请使用 `--hash` 定位」。`<path>` 必须为文件路径，目录 → 报错。
- 操作后重算 `tag_string` 并执行冲突检测。
- `--standard <name|path>`：解析手动路径使用的分类标准，**缺省为内置默认标准**（`default`）。它决定 `tag set` 结果标签数上限（`maxTags`，见 §5.1）；`tagPattern` **不**对 `tag set/add` 重新生效——`set/add` 仅接受**已存在**标签（先创建后使用，见 §5.3），标签库为全局、不与标准绑定，创建时所在标准的 `tagPattern` 已校验过。`tag remove` 只删标签、不涉及命名校验，无需 `--standard`。
- `--format json`：输出统一 envelope（§8.3）；`data` 为操作后的图片对象（形状见 §1.3）。
- `tag set` 结果标签数超 `maxTags` → 报错并回滚，不执行；`tag add` 对**已存在**标签不重跑 `tagPattern`，仅受数量上限约束。
- **命令注册**：`tag` 为仅含子命令（`set`/`add`/`remove`）的命令组，自身无 action；打标是顶层默认命令。子命令名匹配优先于位置参数，故 `imgtagger tag set x` 的 `set` 会被正确派发到子命令。`imgtagger tag` 不带子命令 → 报错并打印用法。

### 8.3 `imgtagger search <query>`（按标签查询图片）

```
imgtagger search [query] [--limit N] [--offset N] [--format text|json]
```

- 无查询参数 → 列出全部图片（按 `tagged_at` 倒序）。
- `query` 为标签表达式（语法见 §2），解析失败报错退出。**位置参数以 `-` 开头时须置于 `--` 分隔符之后**（`--` 后的内容一律按位置参数处理、不再解析为选项）：如反向查询 `imgtagger search -- -a b`，或极少数以 `-` 开头的文件路径。标签名本身不以 `-` 开头，故该约定主要影响反向查询。
- 输出：路径、标签串、格式、尺寸、打标时间；`--format json` 输出结构化结果。含反向项时自动排除未打标图片（`tag_string = ''`）。
- **统一 envelope 与退出码**：`--format <text|json>` 为各命令通用参数，默认 `text`。`json` 时成功 `{ "ok": true, "data": ... }`、错误 `{ "ok": false, "error": { "code", "message" } }` 且非零退出码。**例外：批量打标**——其 `ok` 表达「流程是否完成」而非「结果是否有错」：批量流程完成即 `ok: true`，失败数 >0 时**仅以非零退出码表达**（「批量流程完成 ≠ 无错」，ok 与退出码解耦）。§8.7 `check` 的 `ok` 语义见其小节。各命令 `data` 结构见各自小节：§8.4 标签数组、§8.6 prune 统计、§8.7 check 报告。图片对象形状见 §1.3。
- **退出码**（沿用 `ExitCode`）：

  | 退出码 | 场景 |
  |--------|------|
  | 0 | 成功 |
  | 1 | 泛型 / LLM / 输入校验错误（打标失败、工具轮次耗尽、解析错误、标签名非法或 `tagPattern` 不匹配等） |
  | 2 | 配置错误 |
  | 3 | 标准错误（标准文件缺失/解析失败） |
  | 4 | 图片错误（单图解码/尺寸失败） |
  | 5 | 存储错误（`tags delete` 引用拒绝、`tag set/add` 冲突回滚、`check` 检出异常） |

### 8.4 `imgtagger tags list/create/show/delete`（标签管理）

```
imgtagger tags list [--format text|json]           # 全部标签（标签全局，不关联标准）
imgtagger tags create <name> [--description <text>] [--standard <name|path>]  # 校验后创建；--description 缺省为空串
imgtagger tags show <name>                           # 查看描述、使用图片数
imgtagger tags delete <name>                         # 有引用时拒绝（报错退出码 5，见下）
```

- `tags create` 的 `--description` **缺省为空串**（DB 列 `NOT NULL`，空串为合法缺省）——与 `create_tag` 工具要求带 `description` 不同，手动路径允许不填描述。
- `tags create` 的 `--standard <name|path>`：决定校验所依据的分类标准，**缺省为内置默认标准**（`default`），与 `tag set/add`（§8.2）一致；标准含 `tagPattern` 时追加正则校验（§5.3 第 3 步），不含 `tagPattern` 时等价于仅全局硬规范校验。
- `tags delete`：标签正被 N 张图片引用时拒绝删除，复用 `StorageError`（code `STORAGE`，退出码 5），报错文案「标签 `<name>` 正被 N 张图片引用，拒绝删除；请先使用 `tag remove` 移除该标签」。
- **退出码**：`tags create` 重名或标签名非法/不匹配 `tagPattern` → 输入校验错误（退出码 1）；`tags show` 标签不存在 → 退出码 1；`tags delete` 有引用拒绝 → 退出码 5。
- v1 **不提供** `tags update`：标签描述创建后不可变（避免 LLM 因描述变更产生前后不一致）；需修改语义时先 `tags delete` + `tags create`（`tag remove` 清引用）。v2 候选：`tags merge <old> <new>`（重写引用后删除），用于批量清理被引用标签。

### 8.5 `imgtagger standards list` / `show <name>`

```
imgtagger standards list [--format text|json]          # 列出内置+自定义标准
imgtagger standards show <name> [--format text|json]   # 显示标准完整内容
```

- `list`：文本模式打印元数据表格（名称、描述、来源、路径）；`--format json` 输出标准元数据数组 `[{ name, description, version, source, filePath, tags }]`（统一 envelope，§8.3）。
- `show`：文本模式打印标准完整正文（YAML frontmatter + Markdown 正文）；`--format json` 输出 `{ name, description, version, tags, frontmatter, body }`（统一 envelope）。

### 8.6 `imgtagger images prune`（清除无标签图片）

```
imgtagger images prune [--dry-run] [--yes] [--format text|json]
```

- **匹配条件**：`tag_string = ''` 的全部图片记录（不含任何标签的图片）。不校验磁盘文件是否存在。
- **执行**：删除全部 `tag_string = ''` 的图片记录；标签关联行随之级联清理——级联清理仅删除图片-标签关联行，**不删除任何标签**（含因本次删除而孤立者），孤立标签保留。
- **安全策略**：
  - 默认打印将被删除的记录清单（`image_hash`、`path`、`tagged_at`、命中条数），交互 `y/N` 确认；非 TTY 环境直接报错退出，提示加 `--yes`。
  - `--dry-run`：仅打印清单，不写入。
  - `--yes`：跳过确认（确认清单无异议后再用）。
  - `--format json`：输出统一 envelope；`data` 为 `{ matched: N, deleted: N, items: [...] }`。
- **失败处理**：单条 DELETE 失败 → 整体事务回滚并报错退出，不计入 `failLogDir`（非 LLM 失败，见 §3.3）。
- **不调 LLM**，不进入 LLM 工具循环。

### 8.7 `imgtagger check`（数据库健康检查，只读、不调 LLM）

```
imgtagger check [--format text|json]
```

手动校验数据库健康，用于排查「无冲突不变式」被破坏等异常态。**只读**：不修改数据库、不调 LLM。检查项：

1. **冲突检测**：`tag_string` 非空且相同的多条图片记录（即冲突定义）→ 异常，列出冲突图片 `path`/`image_hash`/`tag_string`。
2. **缓存一致性**：由标签关联实际重算的 `tag_string` 与缓存的 `tag_string` 不一致 → 异常（缓存漂移）。
3. **引用完整性**：标签关联指向不存在的图片/标签（绕过引用约束的库外改动可能引入）→ 异常。
4. **孤儿标签**：无任何图片引用的标签 → 提示（非异常，供清理参考）。
5. **未完成打标**：`tag_string = ''` 的图片数 → 提示（可用 `images prune` 或重跑补标）。

输出与退出码：

- 文本：逐项结果 + 异常汇总；发现异常时附建议修复动作（如"用 `tag set` 重写冲突图片标签"）。
- `--format json`：统一 envelope；检出异常时 envelope 为 `{ ok: false, error: { code: 'STORAGE', message } }`，**`data` 仍携带完整报告**：`{ ok, conflicts: [...], cache_drift: [...], dangling_refs: [...], orphan_tags: [...], untagged: N }`（`data.ok` 与 envelope 的 `ok` 一致），供脚本定位异常。
- 退出码：全部通过 → 0；检出任一异常 → 5（`STORAGE`）。

## 9. 标签串与冲突

### 9.1 标签串定义

`tag_string = image 的全部标签名按 UTF-8 逐字节比较升序排序后用单个空格连接`。

- **存储/规范化排序**：对良构 UTF-8，逐字节比较**等价于按 Unicode 码点排序**，与之真正不同的是 **locale 排序**（`Intl.Collator`：大小写折叠、重音折叠、中文按拼音、数字自然序等，见下）。字节序的直观后果是 **ASCII 大写 < ASCII 小写 < 多字节（中文）**，例如 `'Apple' < 'apple' < '中'`——与人类直觉/locale 排序不同，但保证跨平台确定性。**存储不变**：`tag_string` 缓存、冲突判定、SQL 查询均以该序为准；大小写敏感。
- **展示顺序**（命令表格、错误消息、冲突反馈等向人类呈现标签时的排序）：与存储序无关，另行按 **`Intl.Collator`（默认 locale，`numeric: true`，`sensitivity: 'accent'`）** 排序——数字按自然序（`img2` < `img10`）、大小写不敏感、中文按 locale 序（zh 下为拼音序）；同序标签按 `created_at` 稳定排序。适用于 `tags list` 输出、`search`/`tag` 表格与冲突反馈消息；**不适用于 `tag_string` 本身，也不进入 JSON 输出**（JSON 仅含存储序 `tag_string`）。
- 标签为空集的图片 `tag_string = ''`。

> **设计权衡**：存储采用 UTF-8 字节序是显式取舍——换取跨平台确定性、无 locale 依赖、可直接用 SQLite 字节比较排序；代价是存储序与人类直觉/locale 排序不一致，中文标签混合时 `tag_string` 观感无序。

### 9.2 冲突定义

两条不同图片记录（`image_hash` 不同）的 `tag_string` 非空且相等 → 冲突。`tag_string = ''` 的图片**除外**（暂无标签不冲突）。`tag_string = ''` 的记录视为**未完成打标**：`--mode skip` 重跑、`--dry-run` 均将其当作待处理（§8.1、§3.1）。

> **取舍声明**：`tag_string = ''` 在系统内被统一视为「未完成打标」——即使用户通过 `tag remove` 主动清空某图全部标签，该图在下次 `--mode skip` 重跑时仍会被重新打标。系统不区分「主动清空」与「未完成」，这是简化语义下的已知副作用（对主动清空的用户反直觉，v1 接受）。若 v2 需区分，可引入显式「已清空」状态位，将「待打标」与「已清空」分离。

### 9.3 冲突检测

冲突检测发生在任何会改变图片标签串的写操作之后（事务内）：

- **打标提交后**（见 §7.3，走 LLM 自动解决）。
- **`tag set` / `tag add` 后**（不调 LLM，直接报错并回滚事务，列出冲突图片路径，提示可通过增加区分性标签解决）。
- **`tag remove` 后**（不调 LLM，直接报错并回滚事务；移除后标签串为空则不参与冲突）。

原子性保证：冲突检测在提交事务前执行，冲突时回滚，数据库不产生冲突状态。由此维持"无冲突不变式"——库内任意时刻不存在标签串相同的两条不同图片，故单次提交最多与一张图冲突（见 §7.3.2）。`--dry-run` 在不写入的前提下基于"虚拟写入结果"模拟检测，无副作用（见 §8.1）。

## 10. 并发与一致性

- **无冲突不变式的代码级保证**：v1 采用**单进程、共享数据库连接、事件循环内同步临界区**模型——所有会改变标签串的写路径必须满足「冲突检测 → 写入 → 提交」之间**无异步等待**（同一调用栈内完成）。因事件循环单线程，只要该临界区同步，则无论拆出多少并发 worker、`image_hash` 如何分片，都不可能有另一笔写在两操作之间交错，「无冲突不变式」与「每次提交最多与 1 张图冲突」据此得到**代码级保证**。SQLite `busy_timeout` 与 WAL 仅作偶发锁竞争的兜底。
