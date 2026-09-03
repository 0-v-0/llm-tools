# img-cleanup — 图片清理助手

基于 LLM 视觉比较的图片清理 CLI 工具。读取 img-val 的估值数据库，按估值分组后让 LLM 做批次比较，选出最不值得保留的图片移到指定目录。

## 工作原理

```
DB 查询 → 分组(standard + max_value 桶) → 批次比较(n张/批, LLM选1留)
                                              ↓
                                    落选者汇总
                                     ↓     ↑ 落选者 ≤ m → 移走全部
                            落选者 > m → 锦标赛淘汰 → 移走 ≤ m 张
```

1. **分组**：先按估值标准分组，组内按 max_value 分桶（同桶图片价值相近，比较更有意义）
2. **批次比较**：每 n 张（默认 2）为一批，LLM 基于视觉质量选出 1 张"最值得保留"
3. **锦标赛**：落选者超过 m 张时，配对淘汰直到 ≤ m 张
4. **移走**：将最终选出的图片移到目标目录，同步更新数据库

**重要**：LLM 只看到图片视觉质量和技术元信息（格式/尺寸/文件大小），不透露任何估值信息。

## 前置条件

需要先用 img-val 对图片估值，确保 `~/.img-data/imgval.db` 中有数据。

## 快速开始

```bash
# 安装依赖
pnpm install

# 构建
pnpm --filter img-cleanup build

# 配置环境变量（与 img-val 共用）
export OPENAI_API_KEY=your-key
export OPENAI_MODEL=gpt-4o

# 预览：从数据库中选出 10 张最不值得保留的图片
node img-cleanup/dist/index.js 10 ./to-remove/ --dry-run --verbose

# 实际移走 10 张
node img-cleanup/dist/index.js 10 ./to-remove/

# 移走最低价值的 5%
node img-cleanup/dist/index.js 5% ./to-remove/

# 每批 3 张比较（默认 2）
node img-cleanup/dist/index.js 20 ./to-remove/ --batch-size 3

# 仅处理特定标准或路径
node img-cleanup/dist/index.js 10 ./to-remove/ --standard default-photo
node img-cleanup/dist/index.js 10 ./to-remove/ --path '**/old/**'
```

## 环境变量

与 img-val 完全一致：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENAI_API_BASE` | `https://api.openai.com/v1` | OpenAI 兼容 API 地址 |
| `OPENAI_API_KEY` | — | OpenAI API 密钥 |
| `OPENAI_MODEL` | `gpt-4o` | 模型名称 |
| `ANTHROPIC_API_KEY` | — | Anthropic API 密钥 |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5-20250929` | 模型名称 |
| `IMGDATA_DIR` | `~/.img-data` | 统一数据目录 |

## 配置文件

`~/.img-data/imgcleanup.toml`（`[llm]` 段配置 LLM provider，优先于环境变量；`provider` 未设时按 apiKey 自动选择（双方都在→报错，都没有→报错）。其余为行为调优参数）：

```toml
[llm]
provider = "openai"   # 可选；未设置时按已配置的 apiKey 自动选择（双方都在→报错，都没有→报错）

[llm.openai]
apiBase = "https://api.openai.com/v1"   # 缺失时回退 OPENAI_API_BASE 环境变量
apiKey = "sk-..."                        # 缺失时回退 OPENAI_API_KEY 环境变量
model = "gpt-4o"                         # 缺失时回退 OPENAI_MODEL 环境变量
visionDetail = "high"                    # 仅配置（默认 high，无环境变量）

[llm.anthropic]
apiKey = "sk-ant-..."                    # 缺失时回退 ANTHROPIC_API_KEY 环境变量
model = "claude-sonnet-4-5-20250929"     # 缺失时回退 ANTHROPIC_MODEL 环境变量
apiBase = ""                             # 缺失时回退 ANTHROPIC_API_BASE 环境变量（可选）

batchSize = 2                                    # 每个批次图片数量 n
maxImageDimension = 1568                         # 送入 LLM 前最长边像素限制
bucketBoundaries = [0, 30, 100, 500, 2000, 5000, 15000]  # 估值分桶边界
storeRaw = false                                 # 是否存储 LLM 原始回复
```

## CLI 命令

### `imgcleanup <m> <target-dir>` — 图片清理

```
imgcleanup <m> <target-dir> [options]
```

- `m`：要移走的图片数量（绝对数字如 `50`，或百分比如 `10%`）
- `target-dir`：目标目录路径

选项：

| 选项 | 默认 | 说明 |
|------|------|------|
| `--batch-size <n>` | `2` | 每个批次图片数量 n（≥2） |
| `--path <glob>` | — | 仅处理路径匹配的图片（可重复） |
| `--dry-run` | — | 仅预览，不实际移动文件 |
| `--on-collision <mode>` | `skip` | 同名处理：`skip`/`rename`/`abort` |
| `--standard <name>` | — | 仅处理指定估值标准 |
| `--format <text\|json>` | `text` | 输出格式 |
| `--verbose` | — | 输出详细进度信息 |

## 开发

```bash
pnpm --filter img-cleanup dev        # 开发模式
pnpm --filter img-cleanup test       # 运行测试
pnpm --filter img-cleanup typecheck  # 类型检查
```
