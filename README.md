# LLM Tools

基于 LLM 的一组图片处理命令行工具，以 pnpm monorepo 组织。各工具复用共享的 LLM provider、图片处理与 SQLite 存储基础库，数据与配置统一存放在 `~/.img-data/`。

## 环境要求

- Node.js >= 22
- pnpm

## 快速开始

```bash
pnpm install
```

## 包一览

| 包 | 说明 |
| --- | --- |
| [img-val](./img-val/README.md) | 基于多模态 LLM 的图片估值，输出人民币最低/最高价值区间 |
| [img-cleanup](./img-cleanup/README.md) | 读取 img-val 估值结果，LLM 批次视觉比较并移走最不值得保留的图片 |
| [img-search](./img-search/README.md) | LLM 交互式提问 + 贝叶斯推理的智能图片搜索（Qdrant 语义检索） |
| [img-renamer](./img-renamer/README.md) | 基于 LLM 的图片重命名/聚类工具 |
| [tag-translator](./tag-translator/) | Danbooru 标签批量翻译工具 |
| [@llm-image/shared](./shared/) | 共享基础库：LLM provider（OpenAI / Anthropic）、图片处理与哈希、SQLite、错误处理 |
| [@llm-image/file-index](./file-index/) | 共享文件索引：文件元信息、BLAKE3 内容指纹与 URL 位置（`file-index.db`） |

## 常用命令

```sh
# 各包通用
pnpm --filter <包名> build        # 构建
pnpm --filter <包名> typecheck    # 类型检查
pnpm --filter <包名> test         # 测试
pnpm --filter <包名> dev          # 开发模式（tsx 直跑源码）

# 例：批量估值
pnpm --filter img-val build
node img-val/dist/index.js ./images/ --concurrency 3
```

共享库 `@llm-image/shared` 与 `@llm-image/file-index` 需先于依赖它们的包编译，其它包才能解析到其产物。`img-val` / `img-cleanup` 的 build 脚本会自动先构建 `@llm-image/shared`；`file-index` 及未自动构建 shared 的场景，需先手动执行一次 `pnpm --filter @llm-image/shared build`、`pnpm --filter @llm-image/file-index build`。

## 配置与数据

- **配置文件**：`<IMGDATA_DIR>/<工具名>.toml`（默认 `~/.img-data/imgval.toml`、`imgsearch.toml`、`imgcleanup.toml`）。文件不存在时使用全部默认值。
- **LLM provider**：`[llm]` 段优先于环境变量，缺省字段回退同名环境变量；`provider` 未设置时按已配置的 apiKey 自动选择（两个都配或都没配均报错）。
- **数据目录**：数据库与配置统一存放于 `~/.img-data/`，以工具名区分文件名（`imgval.db`、`imgsearch.db`、`imgcleanup-checkpoint.json`、`file-index.db` …）。可用环境变量 `IMGDATA_DIR` 整体重定位。

## 许可

Apache-2.0