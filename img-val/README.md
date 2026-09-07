# img-val — 图片估值系统

基于 LLM 的静态图片估值 CLI 工具。给定图片与估值标准，调用多模态 LLM 输出人民币最低/最高价值区间，差值代表不确定性。输出附带连续置信度（0–1 浮点数，缺失时显示 `-`）。

## 安装与构建

```bash
# 安装依赖
pnpm install

# 构建（含 dist 复制内置标准与迁移文件）
pnpm --filter img-val build
```

构建产物为 `img-val/dist/index.js`，可通过 `node img-val/dist/index.js` 或安装后的 `imgval` 命令调用。开发相关命令见下文 §开发。

## 快速开始

```bash
# 配置环境变量
cp .env.example .env
# 编辑 .env 设置 API key

# 单图估值
node img-val/dist/index.js ./path/to/image.jpg

# JSON 输出
node img-val/dist/index.js ./path/to/image.jpg --format json

# 批量估值（自动识别目录）
node img-val/dist/index.js ./images/ --concurrency 3

# 递归子目录批量估值
node img-val/dist/index.js ./images/ --recursive --concurrency 4

# 批量估值并显示进度条
node img-val/dist/index.js ./images/ --progress

# 跳过已估值（默认）：指纹+标准同时匹配时跳过
node img-val/dist/index.js ./images/ --mode skip

# 跳过已估值并同步数据库中的 url（文件移动后可修复记录）
node img-val/dist/index.js ./images/ --mode sync

# 全量重新估值
node img-val/dist/index.js ./images/ --mode full

# 搜索历史估值
node img-val/dist/index.js search min:100 max:500

# 查看估值标准
node img-val/dist/index.js standards list
```

## 环境变量

LLM 提供商与数据目录通过环境变量配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENAI_API_BASE` | `https://api.openai.com/v1` | OpenAI 兼容 API 地址 |
| `OPENAI_API_KEY` | — | OpenAI API 密钥 |
| `OPENAI_MODEL` | `gpt-5.6-luna` | 模型名称 |
| `ANTHROPIC_API_KEY` | — | Anthropic API 密钥 |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | 模型名称 |
| `IMGDATA_DIR` | `~/.img-data` | 统一数据目录（三工具共用，配置文件与数据库均存放于此，img-val 使用其中的 `imgval.toml` 与 `imgval.db`） |

## 配置文件

行为调优参数与 LLM provider 配置统一放在配置文件 `~/.img-data/imgval.toml`（若设置了 `IMGDATA_DIR`，则为 `<IMGDATA_DIR>/imgval.toml`）。文件不存在时全部使用默认值；`[llm]` 段中已设置的 provider 字段优先于同名环境变量，未设置的字段回退环境变量；其余调优参数为唯一来源，无同名环境变量覆盖。

```toml
# ~/.img-data/imgval.toml
#
# 所有键均可省略，使用默认值；如下键属于可选调优项：

[llm]
provider = "openai"   # 可选；未设置时按已配置的 apiKey 自动选择（双方都在→报错，都没有→报错）

[llm.openai]
apiBase = "https://api.openai.com/v1"
model = "gpt-5.6-luna"
visionDetail = "high"

[llm.anthropic]
apiKey = "sk-ant-..."                    # 缺失时回退 ANTHROPIC_API_KEY 环境变量
model = "claude-sonnet-5"     # 缺失时回退 ANTHROPIC_MODEL 环境变量
apiBase = ""                             # 缺失时回退 ANTHROPIC_API_BASE 环境变量（可选）

standardsDir = "~/.img-data/standards"   # 估值标准目录
storeRaw = true                          # 是否存储 LLM 原始回复文本
maxImageDimension = 1568                 # 送入 LLM 前最长边像素限制
maxToolRounds = 4                        # 工具调用循环上限
enableTools = true                       # 启用工具调用（仍可用 --no-tools 临时禁用）
failLogDir = ""                          # 失败日志目录；为空或未设置则不记录失败请求

# —— 可选：估值行为调优（以下键对应估值准确度方面的可选能力，默认值即为推荐配置）——
samplesMin = 1                           # 最低价值边界的采样次数（≥1）
samplesMax = 1                           # 最高价值边界的采样次数（≥1）
samplingTemperature = 0.7                # 多样本采样温度（0–2）
enableLogprobs = true                    # 是否请求模型输出 token 的 logprob 用于客观置信度
usePathDecoding = false                  # 受限期望解码（每个边界仅 1 次调用，按候选路径概率加权求期望）
pathTopK = 20                            # 路径解码每个位置保留的候选数（1–20），仅 usePathDecoding=true 时生效
```

## CLI 命令

### `imgval <path>` — 估值 / 批量估值

自动识别：传入文件路径则单张估值，传入目录则批量处理。

```
imgval <path> [--standard <name|path>] [--format <text|json>] [--no-tools] [--verbose]
imgval <dir>  [--standard <name|path>] [--concurrency N] [--include <glob>] [--recursive] [--format <text|json>] [--progress] [--mode <full|skip|sync>] [--no-tools] [--verbose]
```

通用参数：

- `--standard <name|path>`：估值标准名称或标准文件路径（默认 `default-photo`）
- `--format <text|json>`：输出格式（默认 `text`）
- `--no-tools`：禁用工具调用
- `--verbose`：输出调试信息

目录模式下可选：

- `--concurrency N`：并发数（默认 1）
- `--include <glob>`：文件匹配模式（默认 `*.{jpg,jpeg,png,webp}`）
- `--recursive`：递归子目录
- `--progress`：显示实时进度条
- `--mode <full|skip|sync>`：估值模式（默认 `skip`）。`full` 全量重新估值；`skip` 跳过已估值的图片（图片指纹与标准名称同时匹配数据库记录）；`sync` 与 `skip` 相同，但会额外把匹配记录的 `url` 更新为当前路径（图片移动/重命名后可用于同步数据库）

### `imgval search <query>` — 搜索历史

```
imgval search [query] [--filter key=value...] [--limit N] [--format <text|json>]
```

支持前缀查询: `min:100 max:500 standard:photo format:png from:2026-01-01`。

`--filter` 可重复传入结构化条件（键与查询前缀一致：`min`、`max`、`standard`、`from`、`to`、`format`），并覆盖查询中的同名前缀。

### `imgval move-low <threshold> <target-dir>` — 移动低价值图片

```
imgval move-low <threshold> <target-dir> [--limit N] [--path <glob>...] [--on-collision <mode>] [--dry-run] [--format <text|json>]
```

将数据库中最高价值低于阈值的图片文件移动到目标目录。阈值支持两种格式：

- **绝对值**：如 `500`，移动所有最高价值低于 500 的文件
- **百分比**：如 `1%`，移动最高价值最低的 1% 的文件（按总数向上取整）

参数说明：

- `--limit N`：最多移动的图片数量（`0` 表示不限制，默认 0）
- `--path <glob>`：仅处理路径匹配该 glob 的图片（支持 `*`、`**`、`?`，可重复，取并集）
- `--on-collision <mode>`：目标已有同名文件时的处理方式 `skip|rename|abort|keep-max`（默认 `skip`）；`rename` 自动追加 `_1`、`_2` 后缀
- `--dry-run`：仅预览要移动的文件，不实际执行

移动后同步更新数据库中的 URL。推荐先用 `--dry-run` 预览。

```
imgval move-low 500 ./low-value/ --dry-run            # 预览最高价值 < 500 的文件
imgval move-low 500 ./low-value/                      # 实际移动
imgval move-low 1% ./low-value/                       # 移动最便宜的 1%
imgval move-low 1% ./low-value/ --limit 10            # 最便宜 1%，最多 10 张
imgval move-low 500 ./low-value/ --path '**/old/**'   # 仅处理 old 目录下的图片
imgval move-low 500 ./low-value/ --path '**/a/*.jpg' --path '**/b/*.jpg'
imgval move-low 500 ./low-value/ --on-collision rename
```

### `imgval standards [list|show <name>]` — 标准管理

- `imgval standards list`：列出所有可用标准
- `imgval standards show <name>`：显示标准完整内容

## 估值标准格式

标准文件为 YAML frontmatter + Markdown body 的格式，与项目内置标准一致，可参考 `default-photo.md`。

自定义标准放入标准目录（默认 `~/.img-data/standards/*.md`，可通过配置 `standardsDir` 修改）即可。

## 退出码

| 退出码 | 含义 |
|--------|------|
| 0 | 成功 |
| 1 | 一般错误 / LLM 错误 / 标准解析或响应解析错误 |
| 2 | 配置错误（环境变量或配置文件校验失败） |
| 3 | 标准加载错误（标准文件不存在或 frontmatter 无效） |
| 4 | 图片处理错误（批量全失败时退出 4） |
| 5 | 存储错误 |

## 开发

```bash
pnpm --filter img-val dev      # 开发模式
pnpm --filter img-val test     # 运行测试
pnpm --filter img-val typecheck # 类型检查
```