import { ConfigError, createLlmConfigSchema } from '@llm-image/shared';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { getConfigPath } from './paths.ts';

const configSchema = z.object({
	// LLM provider 配置（非密钥字段：显式设置的环境变量优先，否则配置优先、再回退环境变量默认值；visionDetail 仅配置）。
	llm: createLlmConfigSchema('high'),
	// 送 LLM 前最长边限制（rename 视觉输入用）。
	maxImageDimension: z.number().int().positive().default(1568),
	// 并发处理数。
	concurrency: z.number().int().positive().default(2),
	// LLM 超时（秒）。
	timeoutSeconds: z.number().positive().default(60),
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
