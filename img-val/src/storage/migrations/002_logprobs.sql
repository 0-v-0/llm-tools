-- logprobs：记录每个边界（min/max）聚合后的 value token 平均 logprob，
-- 以及各自的采样次数，用于下游置信度校准与审计。
ALTER TABLE valuation ADD COLUMN min_logprob REAL;
ALTER TABLE valuation ADD COLUMN max_logprob REAL;
ALTER TABLE valuation ADD COLUMN samples_min INTEGER NOT NULL DEFAULT 1;
ALTER TABLE valuation ADD COLUMN samples_max INTEGER NOT NULL DEFAULT 1;
-- 连续置信分（0–1）：由较弱边界的聚合 logprob 经 exp 派生，作为数值化置信度落库；
-- 展示层的 low/medium/high 枚举由该分经阈值映射得到，对外契约不变。
ALTER TABLE valuation ADD COLUMN confidence_score REAL;
