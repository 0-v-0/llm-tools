import { ConfigError } from '@llm-image/shared';
import { z } from 'zod';

const envSchema = z.object({
	LLM_PROVIDER: z.enum(['openai', 'anthropic']).default('openai'),

	OPENAI_API_BASE: z.string().default('https://api.openai.com/v1'),
	OPENAI_API_KEY: z.string().optional(),
	OPENAI_MODEL: z.string().default('gpt-4o'),
	OPENAI_VISION_DETAIL: z.enum(['low', 'high', 'auto']).default('high'),

	ANTHROPIC_API_KEY: z.string().optional(),
	ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5-20250929'),
	ANTHROPIC_API_BASE: z.string().optional(),

	LLM_ENABLE_TOOLS: z
		.union([z.string(), z.boolean()])
		.transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
		.default(true),

	IMGVAL_DB_DIR: z.string().optional(),
	IMGVAL_STANDARDS_DIR: z.string().optional(),
	IMGVAL_STORE_RAW: z
		.union([z.string(), z.boolean()])
		.transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
		.default(true),

	IMGVAL_MAX_IMAGE_DIMENSION: z.coerce.number().int().positive().default(1568),
	IMGVAL_MAX_TOOL_ROUNDS: z.coerce.number().int().positive().default(4),

	IMGVAL_FAIL_LOG: z.string().optional(),
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
