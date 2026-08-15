# imgval — 图片估值系统

基于 LLM 的静态图片估值 CLI 工具。给定图片与估值标准，调用多模态 LLM 输出人民币最低/最高价值区间，差值代表不确定性。

## 快速开始

```bash
# 安装依赖
pnpm install

# 构建
pnpm --filter imgval build

# 配置环境变量
cp .env.example .env
# 编辑 .env 设置 API key

# 单图估值
node imgval/dist/index.js ./path/to/image.jpg

# JSON 输出
node imgval/dist/index.js ./path/to/image.jpg --json

# 批量估值（自动识别目录）
node imgval/dist/index.js ./images/ --concurrency 3

# 递归子目录批量估值
node imgval/dist/index.js ./images/ --recursive --concurrency 4

# 批量估值并显示进度条
node imgval/dist/index.js ./images/ --progress

# 跳过已估值的图片（指纹+标准同时匹配）
node imgval/dist/index.js ./images/ --skip-valued

# 搜索历史估值
node imgval/dist/index.js search min:100 max:500

# 查看估值标准
node imgval/dist/index.js standards list
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_PROVIDER` | `openai` | LLM 提供商 (`openai` 或 `anthropic`) |
| `OPENAI_API_BASE` | `https://api.openai.com/v1` | OpenAI 兼容 API 地址 |
| `OPENAI_API_KEY` | — | OpenAI API 密钥 |
| `OPENAI_MODEL` | `gpt-4o` | 模型名称 |
| `OPENAI_VISION_DETAIL` | `high` | Vision 详情级别 |
| `ANTHROPIC_API_KEY` | — | Anthropic API 密钥 |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5-20250929` | 模型名称 |
| `LLM_ENABLE_TOOLS` | `true` | 启用工具调用 |
| `IMGVAL_DB_DIR` | `~/.imgval` | 数据库目录 |
| `IMGVAL_STANDARDS_DIR` | `~/.imgval/standards` | 估值标准目录 |
| `IMGVAL_MAX_IMAGE_DIMENSION` | `1568` | 送入 LLM 前最长边像素限制 |
| `IMGVAL_MAX_TOOL_ROUNDS` | `4` | 工具调用循环上限 |
| `IMGVAL_STORE_RAW` | `true` | 是否存储 LLM 原始回复文本 |
| `IMGVAL_FAIL_LOG` | — | 失败日志目录；若设置，估值失败时写入完整请求 JSON 文件 |

## CLI 命令

### `imgval <path>` — 单图估值 / 批量估值

自动识别：传入文件路径则单张估值，传入目录则批量处理。

```
imgval <path> [--standard <name|path>] [--json] [--no-tools] [--verbose]
imgval <dir>  [--standard <name|path>] [--concurrency N] [--include <glob>] [--recursive] [--json] [--progress] [--skip-valued] [--no-tools] [--verbose]
```

目录模式下可选：

- `--progress`：显示实时进度条
- `--skip-valued`：跳过已估值的图片（图片指纹 `image_hash` 与标准名称 `standard_name` 同时匹配数据库记录）

### `imgval search <query>` — 搜索历史

```
imgval search [query] [--filter key=value...] [--limit N] [--json]
```

支持前缀查询: `min:100 max:500 standard:photo format:png from:2026-01-01`

### `imgval move-low <threshold> <target-dir>` — 移动低价值图片

```
imgval move-low <threshold> <target-dir> [--limit N] [--path <glob>...] [--dry-run] [--json]
```

将数据库中最高价值 (`max_value`) 低于阈值的图片文件移动到目标目录。阈值支持两种格式：

- **绝对值**：如 `500`，移动所有 `max_value` 低于 500 的文件
- **百分比**：如 `1%`，移动 `max_value` 最低的 1% 的文件（按总数向上取整）

`--path <glob>` 可指定图片路径筛选（可重复，取并集），支持 `*`、`**`、`?` 通配符。同名冲突自动追加 `_1`、`_2` 后缀，移动后同步更新数据库中的 URL。推荐先用 `--dry-run` 预览。

```
imgval move-low 500 ./low-value/ --dry-run            # 预览 max_value < 500 的文件
imgval move-low 500 ./low-value/                      # 实际移动
imgval move-low 1% ./low-value/                       # 移动最便宜的 1%
imgval move-low 1% ./low-value/ --limit 10            # 最便宜 1%，最多 10 张
imgval move-low 500 ./low-value/ --path '**/old/**'   # 仅处理 old 目录下的图片
imgval move-low 500 ./low-value/ --path '**/a/*.jpg' --path '**/b/*.jpg'
```

### `imgval standards [list|show <name>]` — 标准管理

## 估值标准格式

与 SKILL.md 格式一致：YAML frontmatter + Markdown body。参见 `default-photo.md`。

自定义标准放入 `~/.imgval/standards/*.md` 即可。

## 开发

```bash
pnpm --filter imgval dev      # 开发模式
pnpm --filter imgval test     # 运行测试
pnpm --filter imgval typecheck # 类型检查
```
