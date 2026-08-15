import { ConfigError } from '@llm-image/shared';
import { z } from 'zod';

const envSchema = z.object({
	// LLM provider (for question generation) — must satisfy ProviderConfig
	LLM_PROVIDER: z.enum(['openai', 'anthropic']).default('openai'),

	OPENAI_API_BASE: z.string().default('https://api.openai.com/v1'),
	OPENAI_API_KEY: z.string().optional(),
	OPENAI_MODEL: z.string().default('gpt-4o'),
	OPENAI_VISION_DETAIL: z.enum(['low', 'high', 'auto']).default('low'),

	ANTHROPIC_API_KEY: z.string().optional(),
	ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5-20250929'),
	ANTHROPIC_API_BASE: z.string().optional(),

	// Embedding (Jina CLIP v2 — multimodal text+image)
	JINA_API_KEY: z.string().optional(),
	JINA_MODEL: z.string().default('jina-clip-v2'),
	JINA_API_BASE: z.string().default('https://api.jina.ai/v1'),
	JINA_DIMENSIONS: z.coerce.number().int().positive().default(1024),

	// Qdrant
	QDRANT_URL: z.string().default('http://localhost:6333'),
	QDRANT_COLLECTION: z.string().default('images'),
	QDRANT_API_KEY: z.string().optional(),

	// imgsearch
	IMGSEARCH_DB_DIR: z.string().optional(),

	// Algorithm parameters
	IMGSEARCH_ALPHA: z.coerce.number().min(0).max(1).default(0.5),
	IMGSEARCH_LAMBDA: z.coerce.number().positive().default(8),
	IMGSEARCH_BEAM_SIZE: z.coerce.number().int().positive().default(500),
	IMGSEARCH_TOPK_QUESTIONS: z.coerce.number().int().positive().default(50),
	IMGSEARCH_CANDIDATE_QUESTIONS: z.coerce.number().int().positive().default(5),
	IMGSEARCH_IG_THRESHOLD: z.coerce.number().positive().default(0.05),
	IMGSEARCH_MAX_ROUNDS: z.coerce.number().int().positive().default(8),
	IMGSEARCH_MIN_ROUNDS: z.coerce.number().int().positive().default(2),
	IMGSEARCH_SHOW_THUMBNAILS: z
		.union([z.string(), z.boolean()])
		.transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
		.default(false),

	// Import
	IMGSEARCH_MAX_IMAGE_DIMENSION: z.coerce.number().int().positive().default(512),
	IMGSEARCH_IMPORT_CONCURRENCY: z.coerce.number().int().positive().default(4),
	IMGSEARCH_EMBED_TEXT_BATCH: z.coerce.number().int().positive().default(64),
	IMGSEARCH_EMBED_IMAGE_BATCH: z.coerce.number().int().positive().default(16),
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
