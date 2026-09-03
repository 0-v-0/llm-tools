import { z } from 'zod';
import type { ProviderConfig } from './factory.js';
import { ConfigError } from '../util/errors.js';

/**
 * TOML `[llm]` 配置段 schema 工厂。
 *
 * `apiBase` / `model` 等非密钥字段为 optional（无默认值），缺失时回退到环境变量。
 * `apiKey` **不从配置文件读取**——仅来自环境变量（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`），
 * 避免将凭据写入明文 TOML 文件。配置文件中已写的 `apiKey` 会被 zod 静默忽略。
 *
 * `visionDetail` 默认值因子项目而异（img-val/img-cleanup = `high`，img-search = `low`），由
 * `visionDetailDefault` 参数注入。
 *
 * `provider` 为 optional：显式设置时使用该值；未设置时由 `resolveProviderConfig`
 * 按环境变量中的 apiKey 自动选择（仅一方有密钥→选该方；双方都有→报错；都没有→报错）。
 *
 * zod 4 的 `.default(value)` 不再对默认值做 schema 解析，且其类型须匹配输出类型
 *（含必填的 `visionDetail`）。因此 `openai` 子对象与外层 `llm` 对象的 default 均
 * 显式提供 `visionDetail`，其余 optional 字段缺省（`undefined` → 回退环境变量）。
 */
export function createLlmConfigSchema(visionDetailDefault: 'low' | 'high' | 'auto') {
	return z
		.object({
			provider: z.enum(['openai', 'anthropic']).optional(),
			openai: z
				.object({
					apiBase: z.string().optional(),
					model: z.string().optional(),
					visionDetail: z.enum(['low', 'high', 'auto']).default(visionDetailDefault),
				})
				.default(() => ({ visionDetail: visionDetailDefault })),
			anthropic: z
				.object({
					model: z.string().optional(),
					apiBase: z.string().optional(),
				})
				.optional(),
		})
		.default(() => ({ openai: { visionDetail: visionDetailDefault } }));
}

export type LlmConfig = z.infer<ReturnType<typeof createLlmConfigSchema>>;

/**
 * 环境变量中可作为回退来源的 LLM provider 字段。
 *
 * 各子项目的 `EnvConfig` 结构上满足此接口。
 */
export interface ProviderEnv {
	OPENAI_API_BASE: string;
	OPENAI_API_KEY?: string | undefined;
	OPENAI_MODEL: string;
	ANTHROPIC_API_KEY?: string | undefined;
	ANTHROPIC_MODEL: string;
	ANTHROPIC_API_BASE?: string | undefined;
}

/**
 * 将 TOML `[llm]` 配置（非密钥字段）与环境变量（密钥 + 回退）合并为 `ProviderConfig`。
 *
 * - `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`：仅来自环境变量（不从配置文件读取）。
 * - `apiBase` / `model` 等非密钥字段：配置有值则用配置，否则回退环境变量。
 * - `provider`：显式设置时直接使用；未设置时按环境变量中的 apiKey 自动
 *   选择——仅一方有密钥选该方，双方都有则报错（无法自动取舍），都没有则报错。
 *
 * 自动检测基于环境变量中的 apiKey。
 */
export function resolveProviderConfig(llm: LlmConfig, env: ProviderEnv): ProviderConfig {
	const openaiApiKey = env.OPENAI_API_KEY;
	const anthropicApiKey = env.ANTHROPIC_API_KEY;

	let provider = llm.provider;
	if (!provider) {
		const hasOpenAI = !!openaiApiKey;
		const hasAnthropic = !!anthropicApiKey;
		if (hasOpenAI && hasAnthropic) {
			throw new ConfigError(
				'LLM provider 未指定，且 OpenAI 与 Anthropic 密钥同时存在，无法自动选择；请在 config.toml [llm] 段显式设置 provider',
			);
		}
		if (hasOpenAI) {
			provider = 'openai';
		} else if (hasAnthropic) {
			provider = 'anthropic';
		} else {
			throw new ConfigError(
				'未配置任何 LLM provider 密钥：请设置环境变量 OPENAI_API_KEY / ANTHROPIC_API_KEY',
			);
		}
	}

	return {
		LLM_PROVIDER: provider,
		OPENAI_API_BASE: llm.openai.apiBase ?? env.OPENAI_API_BASE,
		OPENAI_API_KEY: openaiApiKey,
		OPENAI_MODEL: llm.openai.model ?? env.OPENAI_MODEL,
		OPENAI_VISION_DETAIL: llm.openai.visionDetail,
		ANTHROPIC_API_KEY: anthropicApiKey,
		ANTHROPIC_MODEL: llm.anthropic?.model ?? env.ANTHROPIC_MODEL,
		ANTHROPIC_API_BASE: llm.anthropic?.apiBase ?? env.ANTHROPIC_API_BASE,
	};
}
