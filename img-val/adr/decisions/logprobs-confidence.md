# logprobs 准确度提升与 confidence 类型重构

## 背景

img-val 的 LLM 估值流程对 `min_value` / `max_value` 各边界使用单次调用（`temperature = 0`）获取确定值。单点采样的局限在于：模型在该点的置信度不可见——即使模型自身对数值不确定，也只能返回一个 argmax 值。

同时，`confidence` 字段原为 LLM 自报的枚举值（`low | medium | high`），存在两个问题：

- **主观性**：置信度由 LLM 自评，缺乏客观度量依据。
- **粒度粗**：三档枚举无法区分同一档内的细微差异，下游无法做数值化校准。

## 核心决策

引入 logprobs 机制提升估值准确度，并将 `confidence` 从 LLM 自报枚举重构为由 logprob 派生的连续浮点数。

### 1. 两种准确度模式

- **多样本温度采样聚合**（默认）：对 min/max 各边界独立采样多次，用 `exp(logprob)` 加权聚合。默认各采样 1 次（确定性）。
- **受限期望解码**（constrained expected-value decoding，可选）：每个边界仅 1 次调用，从单次调用内模型自身的 top-k 分布重建候选数值路径，按路径概率加权求期望。同等准确度下 API 调用成本骤降。

两种模式共享同一个聚合算子（概率加权均值），区别仅在于候选来源——前者来自温度扰动产生的多次独立样本，后者来自单次调用内 beam 枚举的 top-k 路径。后者额外施加"有效性掩码"（有限、非负），丢弃无法形成合法数值的路径。

### 2. 数据库 schema 变更

迁移 `002_logprobs.sql` 为 `valuation` 表新增 5 列，记录每个边界（min/max）聚合后的 token 平均 logprob、各自的采样次数，以及由较弱边界 logprob 经 `exp` 派生的连续置信分。后续将 `confidence_score` 列重命名为 `confidence`，使列名与类型语义对齐。

### 3. confidence 类型重构

- `Confidence` 类型从 `'low' | 'medium' | 'high'` 改为 `number`（值域 `(0, 1]`，由聚合 logprob 经 `exp` 派生；无 logprobs 时为 `null`）。
- **LLM 不再被要求自报 confidence**：从 prompt 文本、response schema 及 submit_valuation 工具定义中移除该字段，置信度完全由模型输出分布客观派生。
- 展示层由枚举字符串改为 `toFixed(2)` 数值，缺失时显示 `-`。

### 4. shared 包扩展

`@llm-image/shared` 的 LLM provider 接口新增 logprobs 请求与响应类型，使 OpenAI 与 Anthropic provider 均能返回 per-token 的 top-k 替代 token 及其 logprob，供上游做置信度校准与期望解码。注意：logprobs 仅覆盖文本/JSON content token，工具调用参数 token 不含 logprobs。

核心模块：`img-val/src/valuation/`（估值引擎与期望解码）、`img-val/src/llm/`（prompt 与响应解析）、`img-val/src/storage/`（类型与迁移）、`shared/src/llm/`（provider 接口与两家实现）。

## 权衡分析

**多样本温度采样 vs. 受限期望解码**

| 维度 | 多样本采样 | 受限期望解码 |
|------|-----------|-------------|
| API 调用次数 | N 次 | 1 次 |
| 信息来源 | 温度扰动产生的分布 | 单次调用内模型自身的 top-k 分布 |
| 成本 | 高（多次调用） | 低（单次调用） |
| 准确度 | 高 | 同等（A/B 可对比） |
| 限制 | 无 | top_logprobs 上限 20；候选笛卡尔积爆炸风险（设上限兜底）；仅对 JSON content token 有效 |

默认关闭路径解码以走现有多样本聚合；用户可按需开启以降低成本。

**confidence：LLM 自报枚举 vs. logprob 派生浮点数**

- LLM 自报枚举：主观，粒度粗，浪费 prompt token，但无需 logprobs 支持。
- logprob 派生浮点数：客观（基于模型输出分布），连续可校准，但依赖 provider 返回 logprobs。
- 选择 logprob 派生的关键依据：置信度应反映模型对输出的客观不确定性，而非模型对自身的主观评估。

## 影响范围

- **Schema 变更**：迁移 `002_logprobs.sql` 新增 5 列；后续 `confidence_score` 重命名为 `confidence`，相关接口类型同步调整。
- **Breaking Change（类型）**：`Confidence` 从 `'low' | 'medium' | 'high'` 改为 `number`（`null` 可选）。下游消费该类型的代码需适配。
- **Breaking Change（LLM 契约）**：prompt、response schema、submit_valuation 工具定义移除 `confidence` 字段。LLM 不再返回 confidence。
- **配置项新增**：`samplesMin`、`samplesMax`、`samplingTemperature`、`enableLogprobs`、`usePathDecoding`、`pathTopK`。
- **shared 包**：provider 接口扩展，新增 `LogprobInfo` 系列类型导出。OpenAI 与 Anthropic provider 实现各自的 logprobs 返回逻辑。
- 新增测试覆盖期望解码、引擎聚合、响应解析与配置校验。
