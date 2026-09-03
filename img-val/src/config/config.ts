import { ConfigError, createLlmConfigSchema } from '@llm-image/shared';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { getConfigPath, getStandardsDir } from './paths.js';

const configSchema = z.object({
	// LLM provider 配置（配置优先，环境变量回退；visionDetail 仅配置）。
	llm: createLlmConfigSchema('high'),
	standardsDir: z.string().default(getStandardsDir()),
	storeRaw: z.boolean().default(true),
	maxImageDimension: z.number().int().positive().default(1568),
	maxToolRounds: z.number().int().positive().default(4),
	failLogDir: z.string().optional(),
	enableTools: z.boolean().default(true),
	// logprobs：对 min(客观假设) / max(最好假设) 各自独立采样多次，
	// 用 logprobs 加权聚合，提高校准与稳定性。默认各采样 1 次（确定性、temp=0）。
	samplesMin: z.number().int().min(1).default(1),
	samplesMax: z.number().int().min(1).default(1),
	samplingTemperature: z.number().min(0).max(2).default(0.7),
	enableLogprobs: z.boolean().default(true),
	// 受限期望解码（constrained expected-value decoding）开关。
	// 开启时：每个边界只做 1 次调用（temp=0 + top_logprobs），用单次调用内
	// 模型自身的 top-k 分布重建候选数值路径并求概率加权期望，替代 samples>1
	// 的多调用温度采样聚合。同等准确度下成本骤降。默认关闭（走现有多样本聚合）。
	usePathDecoding: z.boolean().default(false),
	// 路径解码每个位置保留的 top-k 候选（受 OpenAI 上限 20 约束）。仅在
	// usePathDecoding 为 true 时生效。A/B 可调（k 越大覆盖分布主体越全）。
	pathTopK: z.number().int().min(1).max(20).default(20),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(): AppConfig {
	const configPath = getConfigPath(process.env.IMGDATA_DIR);
	if (!existsSync(configPath)) {
		return configSchema.parse({});
	}

	const raw = readFileSync(configPath, 'utf-8');
	let parsed: Record<string, unknown>;
	try {
		parsed = parse(raw) as unknown as Record<string, unknown>;
	} catch (e) {
		throw new ConfigError(
			`配置文件解析失败 ${configPath}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	const result = configSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new ConfigError(`配置文件校验失败: ${issues}`);
	}
	return result.data;
}
