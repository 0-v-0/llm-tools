import { ConfigError } from '@llm-image/shared';
import { z } from 'zod';

const envSchema = z.object({
	OPENAI_API_BASE: z.string().default('https://api.openai.com/v1'),
	OPENAI_API_KEY: z.string().optional(),
	OPENAI_MODEL: z.string().default('gpt-4o'),

	ANTHROPIC_API_KEY: z.string().optional(),
	ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5-20250929'),
	ANTHROPIC_API_BASE: z.string().optional(),

	IMGDATA_DIR: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadEnv(): EnvConfig {
	const parsed = envSchema.safeParse(process.env);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new ConfigError(`环境变量校验失败: ${issues}`);
	}
	return parsed.data;
}
