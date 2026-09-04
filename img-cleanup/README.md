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

```sh
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
checkpointEnabled = true                         # 中断恢复（checkpoint）开关
# checkpointPath = "/custom/path.json"           # 自定义 checkpoint 位置（默认 <IMGDATA_DIR>/imgcleanup-checkpoint.json）


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
| `--resume` | — | 必须从已有 checkpoint 恢复（不存在则报错） |
| `--no-resume` | — | 忽略已有 checkpoint，全新开始 |
| `--force` | — | standard 变更时跳过交互确认，强制复用已完成的比较结果 |
| `--checkpoint <path>` | `<IMGDATA_DIR>/imgcleanup-checkpoint.json` | 自定义 checkpoint 文件路径 |
| `--format <text\|json>` | `text` | 输出格式 |
| `--verbose` | — | 输出详细进度信息 |

## 中断恢复（Checkpoint）

运行过程中每一次 LLM 视觉比较的裁决都会**即时落盘**到 checkpoint 文件。中断
（Ctrl+C / 崩溃 / 网络错误）后**用相同命令重跑**即可续跑，已完成的比较不会重复
调用 LLM：

```sh
# 中断后重跑同一命令，自动命中缓存续跑
imgcleanup 50 ./to-remove/

# 强制全新开始（忽略 checkpoint）
imgcleanup 50 ./to-remove/ --no-resume

# 改了数量或目标目录：复用全部比较结果，仅重算受影响阶段
imgcleanup 20 ./elsewhere/

# standard 变更：警告并要求确认（TTY），--force 跳过确认强制复用
imgcleanup 50 ./to-remove/ --standard recovery-value --force
```

### 复用规则

checkpoint 以「**参与比较的图片集合**」为缓存主键，与分组/批次划分解耦。
LLM 的裁决只取决于这组图片本身（prompt 不含任何估值信息），因此：

| 参数变化 | 行为 |
|---------|------|
| `m`（数量/百分比） | ✅ 批次裁决全部复用；锦标赛按新阈值重算，已比较过的 pair 直接命中 |
| `target-dir` | ✅ 复用全部裁决，仅移动进度重置 |
| `--dry-run` ↔ 实际执行 | ✅ 复用全部裁决（可先预览再真实执行） |
| `--batch-size` / `--path` / 图片增删 | ✅ 重新分组分批，url 集合相同的批次仍命中缓存 |
| `--standard` | ⚠️ 分组依据变化：打印警告并交互确认后复用；非交互终端需 `--force`，否则重新开始 |
| provider / model / `maxImageDimension` / prompt 版本 | ❌ 「裁判换了」，checkpoint 整体作废 |

### 行为细节

- 每个文件移动完成后也会落盘；中断后重跑会跳过已移动的文件，并自动补做
  「已 rename 但未更新数据库」的半完成移动。
- `Ctrl+C` / `SIGTERM` 先保存断点再退出（退出码 130）；`kill -9` 依赖每步即时
  落盘，最多丢失正在进行的一次比较。
- 成功完成后 checkpoint 自动清理；作废时旧文件备份为 `*.bak.<时间戳>`。
- 配置：`checkpointEnabled`（默认 `true`）、`checkpointPath`（`imgcleanup.toml`）。
## 开发

```sh
pnpm --filter img-cleanup dev        # 开发模式
pnpm --filter img-cleanup test       # 运行测试
pnpm --filter img-cleanup typecheck  # 类型检查
```
