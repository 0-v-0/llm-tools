import { ConfigError } from '@llm-image/shared';
import { z } from 'zod';

const envSchema = z.object({
	OPENAI_API_BASE: z.string().default('https://api.openai.com/v1'),
	OPENAI_API_KEY: z.string().optional(),
	OPENAI_MODEL: z.string().default('gpt-5.6-luna'),

	ANTHROPIC_API_KEY: z.string().optional(),
	ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
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

	// img-search（与 img-val、img-tagger 共用统一数据目录）
	IMGDATA_DIR: z.string().min(1).optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

/** https:// 或本地地址视为安全传输（允许携带 API 密钥） */
function isSecureOrLocalUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol === 'https:') return true;
		const host = parsed.hostname;
		return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
	} catch {
		return false;
	}
}

/** 设置了 API 密钥但目标地址不安全时给出警告（密钥可能以明文传输）。 */
function warnInsecureKeyTransport(keyEnvName: string, urlEnvName: string, apiKey: string | undefined, url: string): void {
	if (apiKey && !isSecureOrLocalUrl(url)) {
		console.warn(
			`警告: 已设置 ${keyEnvName}，但 ${urlEnvName} (${url}) 不是 https:// 或本地地址，API 密钥可能以明文传输`,
		);
	}
}

function warnInsecureTransport(env: EnvConfig): void {
	warnInsecureKeyTransport('QDRANT_API_KEY', 'QDRANT_URL', env.QDRANT_API_KEY, env.QDRANT_URL);
	warnInsecureKeyTransport('JINA_API_KEY', 'JINA_API_BASE', env.JINA_API_KEY, env.JINA_API_BASE);
	warnInsecureKeyTransport('OPENAI_API_KEY', 'OPENAI_API_BASE', env.OPENAI_API_KEY, env.OPENAI_API_BASE);
	// ANTHROPIC_API_BASE 可选（默认未设置，走 SDK 内置地址），仅在显式设置时检查
	if (env.ANTHROPIC_API_BASE !== undefined) {
		warnInsecureKeyTransport('ANTHROPIC_API_KEY', 'ANTHROPIC_API_BASE', env.ANTHROPIC_API_KEY, env.ANTHROPIC_API_BASE);
	}
}

export function loadEnv(): EnvConfig {
	const parsed = envSchema.safeParse(process.env);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new ConfigError(`环境变量校验失败: ${issues}`);
	}
	warnInsecureTransport(parsed.data);
	return parsed.data;
}
