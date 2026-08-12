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
node packages/imgval/dist/index.js ./path/to/image.jpg

# JSON 输出
node packages/imgval/dist/index.js ./path/to/image.jpg --json

# 批量估值
node packages/imgval/dist/index.js batch ./images/ --concurrency 3

# 搜索历史估值
node packages/imgval/dist/index.js search min:100 max:500

# 查看估值标准
node packages/imgval/dist/index.js standards list
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

## CLI 命令

### `imgval <image-path>` — 单图估值

```
imgval <image-path> [--standard <name|path>] [--json] [--no-tools] [--verbose]
```

### `imgval batch <dir>` — 批量估值

```
imgval batch <dir> [--standard <name|path>] [--concurrency N] [--include <glob>] [--recursive] [--json]
```

### `imgval search <query>` — 搜索历史

```
imgval search [query] [--filter key=value...] [--limit N] [--json]
```

支持前缀查询: `min:100 max:500 standard:photo format:png from:2026-01-01`

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
