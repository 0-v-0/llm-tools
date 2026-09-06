# img-renamer — 图片重命名与聚类 CLI

LLM 驱动的图片重命名与聚类工具，已纳入 llm-tools 统一框架：

- **commander CLI**（`imgrenamer` 二进制），TS 实现。
- 复用 [`@llm-image/shared`](../shared/README.md) 的 LLM provider（`createProvider` / `resolveProviderConfig` / `createLlmConfigSchema`）与图片处理（`processImage`）。
- 配置走统一数据目录 `~/.img-data/imgrenamer.toml`（`IMGDATA_DIR` 可重定位），`[llm]` 段与 img-val / img-search / img-cleanup 一致（非密钥字段：显式设置的环境变量优先，否则配置文件优先、再回退环境变量默认值）。
## 子命令

### `rename` — LLM 重命名图片

遍历目录中的图片，用多模态 LLM 分析内容生成新的中文文件名并原地重命名。

```bash
imgrenamer rename [dir] [options]
```

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--formats <exts>` | 图片格式列表，逗号分隔 | `jpg,jpeg,png,gif` |
| `--depth <n>` | 最大递归子目录深度 | `Infinity` |
| `--max-size <bytes>` | 超过该大小的文件将被跳过 | `10485760` |
| `--max-retry <n>` | 单个文件失败最大重试次数 | `3` |
| `--concurrency <n>` | 并发数 | `2` |
| `--dry-run` | 仅输出将要执行的重命名日志，不实际修改文件 | `false` |
| `--verbose` | 输出调试信息 | `false` |

示例（仅日志，不实际重命名）：

```bash
imgrenamer rename --dry-run
```

### `cluster` — 图片聚类

按文件名语义 / 分辨率 / 宽高比聚类图片，并移动到类别目录。

```bash
imgrenamer cluster -n <k> [options]
```

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `-n, --n <k>` | 类别数（必需） | — |
| `--metric <name\|resolution\|aspect-ratio>` | 聚类依据 | `name` |
| `--formats <exts>` | 图片格式列表，逗号分隔（空=所有文件） | `''` |
| `--depth <n>` | 最大递归子目录深度 | `Infinity` |
| `--max-retry <n>` | 类别命名 LLM 重试次数 | `3` |
| `--dry-run` | 仅输出将要执行的移动日志，不实际移动文件 | `false` |

示例：

```bash
imgrenamer cluster -n 5 --metric aspect-ratio --dry-run
```

## 配置

`~/.img-data/imgrenamer.toml`（不存在时全部使用默认值）：

```toml
[llm]
provider = "openai"          # 可选；缺省按环境变量密钥自动选择
openai.apiBase = "https://api.openai.com/v1"
openai.model = "gpt-5.6-luna"

maxImageDimension = 1568     # 送 LLM 前最长边限制
concurrency = 2              # rename 并发数
timeoutSeconds = 60          # LLM 超时（秒）
```

- LLM 密钥仅从环境变量读取（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`）。
- `cluster --metric name` 需要 OpenAI 兼容的 embedding 端点（默认模型 `text-embedding-3-small`，可用环境变量 `OPENAI_EMBEDDING_MODEL` 覆盖）。

## 开发

```bash
pnpm --filter img-renamer build   # 构建（先构建 @llm-image/shared）
pnpm --filter img-renamer dev -- rename --dry-run
pnpm --filter img-renamer typecheck
```