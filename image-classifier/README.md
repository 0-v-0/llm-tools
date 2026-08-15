# Image Classifier

本工具是一个命令行应用程序，用于遍历当前工作目录及其所有子目录中的图片文件，通过AI分析图片内容自动提取关键信息，并根据这些信息为图片生成新的文件名。

## 命令行参数

| 参数          | 说明                                       | 默认值      |
| ------------- | ------------------------------------------ | ----------- |
| `--formats`   | 图片格式列表                               | jpg,png,gif |
| `--depth`     | 最大递归子目录深度                         | Infinity    |
| `--max-size`  | 超过该大小文件将被跳过（单位：字节）       | 10485760    |
| `--max-retry` | 单个文件失败最大重试次数                   | 3           |
| `--timeout`   | 请求超时                                   | 60          |
| `--dry-run`   | 仅输出将要执行的重命名日志，不实际修改文件 | false       |

## 输出示例

```
[INFO] 找到 156 个图片文件
[INFO] 已处理 20 个文件
[INFO] 已处理 40 个文件
...
[INFO] 成功：156 个文件
[INFO] 跳过：0 个文件
[INFO] 失败：0 个文件
[INFO] 耗时：72.3 s
```

示例（仅日志，不执行重命名）：

```
node image-classifier/classifier.js --dry-run
```

## cluster.js

`cluster.js` 会先遍历当前目录下的图片文件，再根据 `--metric` 选择聚类依据：

- `name`：按文件名语义聚类
- `resolution`：按图片分辨率聚类
- `aspect-ratio`：按图片宽高比聚类

示例：

```bash
node image-classifier/cluster.js -n 5 --metric aspect-ratio
```
