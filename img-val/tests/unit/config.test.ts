import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { resolveProviderConfig } from '@llm-image/shared';
import type { LlmConfig, ProviderEnv } from '@llm-image/shared';

const origEnvDbDir = process.env.IMGDATA_DIR;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'img-val-config-'));
	process.env.IMGDATA_DIR = dir;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (origEnvDbDir === undefined) {
		delete process.env.IMGDATA_DIR;
	} else {
		process.env.IMGDATA_DIR = origEnvDbDir;
	}
});

describe('loadConfig', () => {
	it('配置文件不存在时返回默认值', () => {
		const config = loadConfig();
		expect(config.standardsDir).toBe(join(homedir(), '.img-data', 'standards'));
		expect(config.storeRaw).toBe(true);
		expect(config.maxImageDimension).toBe(1568);
		expect(config.maxToolRounds).toBe(4);
		expect(config.enableTools).toBe(true);
		expect(config.failLogDir).toBeUndefined();
	});

	it('usePathDecoding 默认关闭、pathTopK 默认 20，且可显式开启', () => {
		const def = loadConfig();
		expect(def.usePathDecoding).toBe(false);
		expect(def.pathTopK).toBe(20);

		writeFileSync(join(dir, 'imgval.toml'), 'usePathDecoding = true\npathTopK = 5\n');
		const cfg = loadConfig();
		expect(cfg.usePathDecoding).toBe(true);
		expect(cfg.pathTopK).toBe(5);
	});

	it('读取并校验有效 TOML 配置', () => {
		writeFileSync(
			join(dir, 'imgval.toml'),
			'standardsDir = "/data/standards"\nstoreRaw = false\nmaxImageDimension = 1024\nmaxToolRounds = 6\nenableTools = false\nfailLogDir = ""\n',
		);
		const config = loadConfig();
		expect(config.standardsDir).toBe('/data/standards');
		expect(config.storeRaw).toBe(false);
		expect(config.maxImageDimension).toBe(1024);
		expect(config.maxToolRounds).toBe(6);
		expect(config.enableTools).toBe(false);
		expect(config.failLogDir).toBe('');
	});

	it('非法 TOML 抛 ConfigError', () => {
		writeFileSync(join(dir, 'imgval.toml'), 'maxToolRounds = [1,');
		expect(() => loadConfig()).toThrow(/配置文件解析失败/);
	});

	it('类型错误抛 ConfigError', () => {
		writeFileSync(join(dir, 'imgval.toml'), 'maxImageDimension = "abc"\n');
		expect(() => loadConfig()).toThrow(/配置文件校验失败/);
	});

	it('llm 段默认值：visionDetail=high，其余字段未设置（交由环境变量回退）', () => {
		const config = loadConfig();
		expect(config.llm.openai.visionDetail).toBe('high');
		expect(config.llm.openai.apiBase).toBeUndefined();
		expect(config.llm.openai.model).toBeUndefined();
		expect(config.llm.anthropic).toBeUndefined();
		// provider 默认未设置（由 resolveProviderConfig 自动检测）
		expect(config.llm.provider).toBeUndefined();
	});

	it('llm.openai 段从 TOML 读取并覆盖默认 visionDetail', () => {
		writeFileSync(
			join(dir, 'imgval.toml'),
			'[llm.openai]\napiBase = "https://my.proxy/v1"\nmodel = "gpt-4o-mini"\nvisionDetail = "low"\n',
		);
		const config = loadConfig();
		expect(config.llm.openai.apiBase).toBe('https://my.proxy/v1');
		expect(config.llm.openai.model).toBe('gpt-4o-mini');
		expect(config.llm.openai.visionDetail).toBe('low');
	});

	it('llm.openai 部分字段：已设置取配置，缺失保持 undefined（环境变量回退）', () => {
		writeFileSync(join(dir, 'imgval.toml'), '[llm.openai]\napiBase = "https://my.proxy/v1"\n');
		const config = loadConfig();
		expect(config.llm.openai.apiBase).toBe('https://my.proxy/v1');
		expect(config.llm.openai.model).toBeUndefined();
		// visionDetail 仍取默认值（配置唯一来源，无环境变量回退）
		expect(config.llm.openai.visionDetail).toBe('high');
		// apiKey 不从配置文件读取（静默忽略），仅来自环境变量
	});

	it('llm.anthropic 段从 TOML 读取', () => {
		writeFileSync(
			join(dir, 'imgval.toml'),
			'[llm.anthropic]\nmodel = "claude-opus"\n',
		);
		const config = loadConfig();
		expect(config.llm.anthropic?.model).toBe('claude-opus');
		expect(config.llm.anthropic?.apiBase).toBeUndefined();
	});

	it('llm.provider 段：默认未设置；显式设置时从 TOML 读取', () => {
		expect(loadConfig().llm.provider).toBeUndefined();
		writeFileSync(join(dir, 'imgval.toml'), '[llm]\nprovider = "anthropic"\n');
		expect(loadConfig().llm.provider).toBe('anthropic');
	});
});

/**
 * resolveProviderConfig 的 provider 选择逻辑：
 * - 显式 [llm].provider → 直接使用；
 * - 未设置 → 按环境变量中的 apiKey 自动选择：
 *   仅一方有密钥→选该方；双方都有→报错；都没有→报错。
 */
describe('resolveProviderConfig (LLM provider 选择)', () => {
	const baseLlm = { openai: { visionDetail: 'high' } } as unknown as LlmConfig;

	function env(openaiKey?: string, anthropicKey?: string): ProviderEnv {
		return {
			OPENAI_API_BASE: 'https://api.openai.com/v1',
			OPENAI_MODEL: 'gpt-4o',
			ANTHROPIC_MODEL: 'claude-sonnet-4-5-20250929',
			OPENAI_API_KEY: openaiKey,
			ANTHROPIC_API_KEY: anthropicKey,
		} as unknown as ProviderEnv;
	}

	it('显式 provider 优先，不触发自动检测', () => {
		const llm = { provider: 'anthropic', openai: { visionDetail: 'high' } } as unknown as LlmConfig;
		// 即使两方密钥都在，显式 provider 仍胜出
		const cfg = resolveProviderConfig(llm, env('openai-k', 'anthropic-k'));
		expect(cfg.LLM_PROVIDER).toBe('anthropic');
	});

	it('未设 provider 且仅 OpenAI 密钥 → 自动选 openai', () => {
		const cfg = resolveProviderConfig(baseLlm, env('openai-k'));
		expect(cfg.LLM_PROVIDER).toBe('openai');
		expect(cfg.OPENAI_API_KEY).toBe('openai-k');
		expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it('未设 provider 且仅 Anthropic 密钥 → 自动选 anthropic', () => {
		const cfg = resolveProviderConfig(baseLlm, env(undefined, 'anthropic-k'));
		expect(cfg.LLM_PROVIDER).toBe('anthropic');
		expect(cfg.ANTHROPIC_API_KEY).toBe('anthropic-k');
		expect(cfg.OPENAI_API_KEY).toBeUndefined();
	});

	it('未设 provider 且双方密钥都在 → 报错（无法自动取舍）', () => {
		expect(() => resolveProviderConfig(baseLlm, env('openai-k', 'anthropic-k'))).toThrow(
			/无法自动选择/,
		);
	});

	it('未设 provider 且无任何密钥 → 报错', () => {
		expect(() => resolveProviderConfig(baseLlm, env())).toThrow(/未配置任何/);
	});

	it('配置文件中的 apiKey 被静默忽略，仅使用环境变量密钥', () => {
		const llm = { openai: { visionDetail: 'high', apiKey: 'cfg-key' } } as unknown as LlmConfig;
		// 配置中的 apiKey 被忽略；环境变量 openai 密钥 → 选 openai
		const cfg = resolveProviderConfig(llm, env('env-key'));
		expect(cfg.LLM_PROVIDER).toBe('openai');
		expect(cfg.OPENAI_API_KEY).toBe('env-key');
	});

	it('配置文件中的 anthropic apiKey 被忽略，不触发「双方都在」报错', () => {
		const llm = { openai: { visionDetail: 'high' }, anthropic: { apiKey: 'cfg-anthropic' } } as unknown as LlmConfig;
		// 配置中的 anthropic apiKey 被忽略；环境变量仅 openai 密钥 → 选 openai，不报错
		const cfg = resolveProviderConfig(llm, env('env-openai'));
		expect(cfg.LLM_PROVIDER).toBe('openai');
		expect(cfg.OPENAI_API_KEY).toBe('env-openai');
		expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
	});
});
