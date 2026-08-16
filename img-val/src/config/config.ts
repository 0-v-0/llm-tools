import { ConfigError } from '@llm-image/shared';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { getConfigPath, getStandardsDir } from './paths.js';

const configSchema = z.object({
	standardsDir: z.string().default(getStandardsDir()),
	storeRaw: z.boolean().default(true),
	maxImageDimension: z.number().int().positive().default(1568),
	maxToolRounds: z.number().int().positive().default(4),
	failLogDir: z.string().optional(),
	enableTools: z.boolean().default(true),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(): AppConfig {
	const configPath = getConfigPath(process.env.IMGVAL_DB_DIR);
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
