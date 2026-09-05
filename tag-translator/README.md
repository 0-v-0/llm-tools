# tag-translator

**Danbooru 标签批量翻译工具**（独立 / 遗留 CLI）。

按行读取标签列表文件，将每个 Danbooru 标签翻译为中文，并输出到新文件。翻译通过 OpenAI 兼容的补全接口完成。

## 运行方式

前置要求：

- Node.js >= 22（与仓库其它包一致）
- 一个 OpenAI 兼容的补全接口服务

运行：

```bash
node index.js <输入文件>
```

- 输入文件：按行组织的标签列表，每行形如 `标签=...`；翻译时仅取 `=` 之前的部分作为待翻译标签，结果追加到该行 `=` 之后。
- 输出文件：与输入文件同目录，命名为 `<原名去扩展名>-tr<扩展名>`（例如 `tags.txt` → `tags-tr.txt`）。

## 配置

配置直接在 `index.js` 顶部修改：

- API 地址（`baseURL`）
- 模型名（`model`）
- API Key（`apiKey`）
