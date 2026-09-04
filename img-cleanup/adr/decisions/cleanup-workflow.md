# 图片清理助手工作流

## 背景

img-val 已能对图片估值并存入 SQLite 数据库。当用户需要在大量已估值图片中
"精简"——移走最不值得保留的 m 张——时，单纯按 `max_value` 升序排序（即
`move-low` 命令的做法）存在局限：

1. **估值偏差**：LLM 估值可能存在系统性偏差，直接按数值排序不够鲁棒。
2. **同价值段内差异不可见**：两张 max_value 都为 500 的图片，一张构图精良
   仅因分辨率低被低估，另一张内容平庸——按数值无法区分。
3. **用户信任**：纯数值排序缺少"为什么这张该删"的可解释理由。

因此需要一个基于 LLM 视觉比较的清理流程：在估值分桶后做批次比较，让 LLM
基于视觉质量选出"最值得保留"的，最终移走落选者。

## 核心决策

### 1. 独立包 `img-cleanup`

作为 monorepo 中的独立 workspace 包，通过 `@llm-image/shared` 读取
imgval.db。不修改 img-val 的代码或数据库 schema。DB 以无迁移模式打开
（不运行 img-val 的 migration 目录）。

### 2. 三阶段流水线

```
DB 查询 → 分组(standard + max_value 桶) → 批次比较(n张/批,LLM选1留)
                                              ↓
                                    落选者汇总
                                     ↓     ↑ 落选者 ≤ m → 移走全部
                            落选者 > m → 锦标赛淘汰 → 移走 ≤ m 张
```

- **分组**：先按 `standard_name` 分组，组内按 `max_value` 分桶（默认边界
  对应 default-photo 参考区间：0/30/100/500/2000/5000/15000）。同桶图片
  价值相近，LLM 比较更有意义。
- **批次比较**：每 n 张（默认 2）为一批，LLM 接收图片 + 技术元信息（格式、
  尺寸、文件大小、通道数、损坏状态），选出 1 张"最值得保留"，其余为落选者。
  批次仅 1 张时自动保留（不调用 LLM）。
- **锦标赛**：落选者 > m 时，配对（n=2）做淘汰赛。每轮 LLM 选 1 张保留，
  另一张继续作为移除候选，直到候选数 ≤ m。奇数轮次最后一张自动轮空保留。

### 3. 不透露估值信息

LLM prompt 中只包含视觉质量维度（构图、清晰度、光影色彩、主题吸引力、
技术参数）和 DB 中的技术元信息（image_format、width、height、channels、
size_bytes、undecodable_pixels）。不包含 min_value、max_value、description、
confidence 等任何估值相关字段。

### 4. m 支持绝对数量和百分比

与 `move-low` 阈值语法一致：纯数字（如 `50`）为绝对数量，带 `%`（如 `10%`）
为占数据库总图片数的百分比（向上取整）。

### 5. 落选者不足 m 时移走全部

若落选者总数 < m，移走全部落选者并报告实际移走数量（不破坏 LLM 判断、
不从保留者中补选）。

## 权衡分析

### 分桶 vs 直接按数值排序

- **分桶优点**：同价值段内 LLM 视觉比较有意义；避免跨段比较（500 元图
  与 5 元图比较无意义）。
- **分桶缺点**：桶边界需要预设，不同标准的参考区间可能不同。当前以
  default-photo 区间为默认，可通过 `bucketBoundaries` 配置。

### 锦标赛 vs 一轮批次法

- **锦标赛优点**：多轮 LLM 裁决更可靠，每轮淘汰约半数，收敛快。
- **锦标赛缺点**：LLM 调用次数 = O(locales.length)，成本高于单轮。但
  相比"不淘汰直接按数值取前 m"更鲁棒。
- **选择锦标赛**：用户明确选择。

### 独立包 vs imgval 子命令

- **独立包优点**：不侵入 img-val 代码；职责清晰。
- **独立包缺点**：重复部分工具函数（url.ts、path-match.ts）。但这些函数
  体量小且稳定，复制成本低于跨包依赖。

### 6. 中断恢复：以「比较图片集合」为键的裁决缓存

流水线中断（Ctrl+C / 崩溃 / 网络错误）后，已完成的 LLM 视觉比较若不能复用，
重跑成本随图片规模线性增长。因此引入 checkpoint 机制：

- **存储**：单 JSON 文件 `<IMGDATA_DIR>/imgcleanup-checkpoint.json`，原子写
  （tmp + rename），每完成一次比较即落盘。不使用 SQLite——img-cleanup 以无
  迁移方式只读式打开 imgval.db，不往估值库写私有表。
- **缓存键**：`sha256(sorted(urls))`。LLM 的裁决只取决于「这组图片是谁」
  （prompt 不含任何估值信息，见决策 3），因此该键与分组/批次划分方式解耦。
- **分层复用**：`m`、`target-dir`、`batchSize`、`bucketBoundaries`、`--path`、
  图片集合增删都只影响「怎么分组」或下游阶段，不影响「这组图谁最值得保留」，
  全部按 URL 匹配复用。`--standard` 变化改变分组依据：按用户要求打印警告并
  交互确认后复用（`--force` 跳过确认；非交互终端未确认则重新开始）。
- **作废条件**：仅「裁判换了」——provider / model / maxImageDimension /
  prompt 版本任一变化，或 checkpoint 损坏 / schema 版本不兼容。
- **锦标赛**：pair 裁决同样入缓存。候选顺序由批次结果确定性推导，故 `m` 变化
  时已比较过的 pair 仍命中，只比较新出现的 pair。
- **移动阶段**：按源路径记录进度，中断后跳过已移动文件；「已 rename 未更新
  DB」的半完成移动在恢复时自动补做。

权衡：按 URL 集合缓存（而非按批次下标）牺牲了少量缓存条目体积，换来任意
参数变化下的最大复用率与对确定性排序的弱依赖。

## 影响范围

- 新增 `img-cleanup/` 目录，纳入 pnpm workspace。
- 读取 `~/.img-data/imgval.db`（由 img-val 创建）和 `~/.img-data/fileindex.db`
  （由 file-index 创建）。
- 移动文件后更新两个数据库中的 URL 记录（与 move-low 行为一致）。
- 新增配置文件 `~/.img-data/imgcleanup.toml`（含 `checkpointEnabled` / `checkpointPath`）。
- 新增中断恢复 checkpoint 文件 `~/.img-data/imgcleanup-checkpoint.json`。
- 不修改任何现有包的代码或数据库 schema。
