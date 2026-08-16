# LLM Tools

基于 LLM 的一系列图片处理命令行工具，以 pnpm monorepo 组织。

## 环境要求

- Node.js >= 22
- pnpm

## 快速开始

```bash
pnpm install
```

按需构建与运行各工具，见各包文档：

| 包 | 说明 |
| --- | --- |
| [`imgsearch`](./imgsearch/README.md) | 通过 LLM 交互式提问的智能图片搜索（贝叶斯推理 + Qdrant） |
| [`imgval`](./imgval/README.md) | 基于多模态 LLM 的图片估值工具 |
| [`image-classifier`](./image-classifier/README.md) | 基于 LLM 的图片重命名/聚类工具 |
| [`tag-translator`](./tag-translator/) | Danbooru 标签批量翻译工具 |
| [`shared`](./shared/) | 共享基础库：LLM provider、图片处理、SQLite 存储、错误处理 |

## 开发

各工具常用命令（以 `imgval` 为例）：

```bash
pnpm --filter imgval dev        # 开发模式
pnpm --filter imgval build      # 构建
pnpm --filter imgval test       # 测试
pnpm --filter imgval typecheck  # 类型检查
```

`shared` 需要在构建前先编译：`pnpm --filter @llm-image/shared build`（`imgval` 的 build 脚本会自动执行）。

## 许可

Apache-2.0