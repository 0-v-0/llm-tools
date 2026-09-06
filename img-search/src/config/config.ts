import { ConfigError, createLlmConfigSchema } from '@llm-image/shared';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { toErrorMessage } from '../util/error-message.ts';
import { getConfigPath } from './paths.ts';

const configSchema = z.object({
	llm: createLlmConfigSchema('low'),
	// Algorithm parameters
	alpha: z.number().min(0).max(1).default(0.5),
	lambda: z.number().positive().default(8),
	beamSize: z.number().int().positive().default(500),
	topKQuestions: z.number().int().positive().default(50),
	candidateQuestions: z.number().int().positive().default(5),
	igThreshold: z.number().positive().default(0.05),
	maxRounds: z.number().int().positive().default(8),
	minRounds: z.number().int().positive().default(2),

	// Import
	maxImageDimension: z.number().int().positive().default(512),
	importConcurrency: z.number().int().positive().default(4),
	embedTextBatch: z.number().int().positive().default(64),
	embedImageBatch: z.number().int().positive().default(16),
}).superRefine((data, ctx) => {
	// 交叉校验：maxRounds < minRounds 会静默禁用低信息增益提前终止
	if (data.maxRounds < data.minRounds) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['maxRounds'],
			message: `maxRounds (${data.maxRounds}) 必须大于等于 minRounds (${data.minRounds})`,
		});
	}
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
		throw new ConfigError(`配置文件解析失败 ${configPath}: ${toErrorMessage(e)}`);
	}

	const result = configSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new ConfigError(`配置文件校验失败: ${issues}`);
	}
	return result.data;
}
