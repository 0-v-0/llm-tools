# 消除 min/max 相互锚定

## 背景

img-val 原本对每张图片只发起**一次** LLM 调用，要求模型在一个 JSON 中同时输出 `min_value` 与 `max_value`。这一方案存在明显缺陷：

- **自回归锚定**：模型在同一个解码序列中先生成 `min_value`、后生成 `max_value`，自回归生成使 `max` 极易被刚写下的 `min` 锚定，导致区间被压缩、两边界趋同，损失不确定性的表达价值。
- **与标准语义不符**：估值标准（`recovery-value.md` 等）本就把 `min`=客观假设、`max`=最好假设定义为**两个独立情境**，而非同一个生成序列里的两个并列数字。

## 核心决策

将估值的两个边界改为**两次相互独立的 LLM 请求**，各自仅估算一个边界：

- **`min` 请求**：只要求 `min_value`（客观假设下的最低价值）+ rationale，并显式禁止推导 `max_value`。
- **`max` 请求**：只要求 `max_value`（最好假设下的最高价值）+ rationale，并显式禁止推导 `min_value`。
- 两次请求各自携带对应的 prompt 与 response schema（`parseMinResponse` / `parseMaxResponse`，以及各自独立的 submit 工具 schema），互不共享生成上下文。
- 保留 **`bound` 未指定的合并回退路径**（单次同时输出 min+max），用于兼容旧测试与旧调用方。
- 结果 reconcile：若出现 `max < min`，按数值重排为合法区间并标注「上下界估算交叉」；整体 confidence 取两边界较弱者；rationale 合并「下界(客观假设) + 上界(最好假设)」；token 求和；`rawLlmText` 存两段文本。

## 权衡分析

| | 单次合并请求 | 两次独立请求（已选择） |
|--|------------|----------------------|
| LLM 调用次数 | 1 | 2 |
| min/max 相互锚定 | 存在（同一解码序列） | 消除（各自独立情境） |
| 与标准语义一致性 | 弱（一个 JSON 并列两数） | 强（min/max 独立情境） |
| 上下文 | 两边界共享一次标准+图片上下文 | 每次请求都带标准+图片上下文 |
| 成本 | 低 | 2× 主模型调用与延迟（含工具可能各跑一次） |

选择两次独立请求的关键依据：消除两数值相互锚定、并与「min=客观假设 / max=最好假设」的标准语义对齐，其收益大于额外一次调用成本。该决策同时构成后续 logprobs 校准与受限期望解码的工作基础（两个边界各自独立采样/解码），见 [logprobs-confidence.md](logprobs-confidence.md)。

## 影响范围

- **LLM 请求/响应契约变更**：单次合并响应拆分为 `min`/`max` 两次独立响应；新增 `bound?: 'min'|'max'` 参数与各自的 schema/解析函数。
- **工具流变更**：submit 工具由传入的 `responseSchema` 经 `submitToolFor` 派生（min/max 各自携带对应边界 schema），不再硬编码 `SUBMIT_VALUATION_TOOL`。
- **引擎变更**：`valuate` 先跑 `bound='min'` 再跑 `bound='max'`（各 `runToolFlow` + 解析），`finalizeValuation` 负责 reconcile。
- **代价/已知**：2× 主模型调用与延迟。建议真实环境用 A/B 验证锚定是否严重再决定是否长期上线（默认已启用两次独立请求）。
- **兼容性**：`bound` 未指定时保留原合并行为，兼容旧测试与旧调用方。
