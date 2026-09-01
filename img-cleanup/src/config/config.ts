import { ConfigError } from '@llm-image/shared';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { getConfigPath } from './paths.js';

const configSchema = z.object({
	/** 每个批次中图片的数量 n，LLM 从中选 1 张最值得保留。默认 2。 */
	batchSize: z.number().int().min(2).default(2),
	/** 送入 LLM 前最长边像素限制。与 img-val 一致。 */
	maxImageDimension: z.number().int().positive().default(1568),
	/** 估值分桶边界（按 max_value）。默认对应 default-photo 标准参考价格区间。 */
	bucketBoundaries: z.array(z.number().nonnegative()).default([0, 30, 100, 500, 2000, 5000, 15000]),
	/** LLM 工具调用最大轮次（保留以备扩展，当前不使用工具）。 */
	maxToolRounds: z.number().int().positive().default(4),
	/** 是否存储 LLM 原始回复（用于审计）。 */
	storeRaw: z.boolean().default(false),
	/** 失败日志目录。 */
	failLogDir: z.string().optional(),
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
