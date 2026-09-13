import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.ts';

const origImgDataDir = process.env.IMGDATA_DIR;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'img-search-config-'));
	process.env.IMGDATA_DIR = dir;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (origImgDataDir === undefined) {
		delete process.env.IMGDATA_DIR;
	} else {
		process.env.IMGDATA_DIR = origImgDataDir;
	}
});

/** 在临时数据目录中写入 imgsearch.toml。 */
function writeConfigToml(content: string): void {
	writeFileSync(join(dir, 'imgsearch.toml'), content);
}

/** 标量字段的默认值（llm 段单独测试）。 */
const scalarFieldDefaults = {
	alpha: 0.5,
	lambda: 8,
	beamSize: 500,
	topKQuestions: 50,
	candidateQuestions: 5,
	igThreshold: 0.05,
	maxRounds: 8,
	minRounds: 2,
	maxImageDimension: 512,
	importConcurrency: 4,
	embedTextBatch: 64,
	embedImageBatch: 16,
} as const;

describe('loadConfig', () => {
	it('配置文件不存在时返回默认值', () => {
		const config = loadConfig();
		for (const [field, expected] of Object.entries(scalarFieldDefaults)) {
			expect(config[field as keyof typeof scalarFieldDefaults]).toBe(expected);
		}
	});

	it('读取并校验有效 TOML 配置', () => {
		const overrides = {
			alpha: 0.3,
			lambda: 16,
			beamSize: 100,
			topKQuestions: 20,
			candidateQuestions: 3,
			igThreshold: 0.1,
			maxRounds: 12,
			minRounds: 3,
			maxImageDimension: 1024,
			importConcurrency: 2,
			embedTextBatch: 32,
			embedImageBatch: 8,
		};
		writeConfigToml(
			Object.entries(overrides)
				.map(([field, value]) => `${field} = ${JSON.stringify(value)}`)
				.join('\n') + '\n',
		);
		const config = loadConfig();
		for (const [field, expected] of Object.entries(overrides)) {
			expect(config[field as keyof typeof overrides]).toBe(expected);
		}
	});

	it('非法 TOML 抛 ConfigError', () => {
		writeConfigToml('beamSize = [1,');
		expect(() => loadConfig()).toThrow(/配置文件解析失败/);
	});

	it('类型错误抛 ConfigError', () => {
		writeConfigToml('lambda = "abc"\n');
		expect(() => loadConfig()).toThrow(/配置文件校验失败/);
	});

	it('maxRounds < minRounds 抛 ConfigError（交叉校验）', () => {
		writeConfigToml('maxRounds = 1\nminRounds = 2\n');
		expect(() => loadConfig()).toThrow(/maxRounds \(1\) 必须大于等于 minRounds \(2\)/);
	});

	it('maxRounds == minRounds 校验通过', () => {
		writeConfigToml('maxRounds = 4\nminRounds = 4\n');
		const config = loadConfig();
		expect(config.maxRounds).toBe(4);
		expect(config.minRounds).toBe(4);
	});

	it('maxRounds > minRounds 校验通过', () => {
		writeConfigToml('maxRounds = 5\nminRounds = 3\n');
		const config = loadConfig();
		expect(config.maxRounds).toBe(5);
		expect(config.minRounds).toBe(3);
	});

	it.each([-0.1, 1.1])('alpha = %s 超出 [0, 1] 抛 ConfigError', (alpha) => {
		writeConfigToml(`alpha = ${alpha}\n`);
		expect(() => loadConfig()).toThrow(/配置文件校验失败/);
	});

	it.each([0, -8])('lambda = %s 非正数抛 ConfigError', (lambda) => {
		writeConfigToml(`lambda = ${lambda}\n`);
		expect(() => loadConfig()).toThrow(/配置文件校验失败/);
	});

	it.each([0.5, -1])('beamSize = %s 非正整数抛 ConfigError', (beamSize) => {
		writeConfigToml(`beamSize = ${beamSize}\n`);
		expect(() => loadConfig()).toThrow(/配置文件校验失败/);
	});

	it.each([0, -0.05])('igThreshold = %s 非正数抛 ConfigError', (igThreshold) => {
		writeConfigToml(`igThreshold = ${igThreshold}\n`);
		expect(() => loadConfig()).toThrow(/配置文件校验失败/);
	});

	it('TOML 仅设置部分字段时其余字段取默认值', () => {
		writeConfigToml('alpha = 0.7\nbeamSize = 100\n');
		const config = loadConfig();
		// 已设置的字段取配置值
		expect(config.alpha).toBe(0.7);
		expect(config.beamSize).toBe(100);
		// 未设置的字段应用默认值
		for (const [field, expected] of Object.entries(scalarFieldDefaults)) {
			if (field === 'alpha' || field === 'beamSize') continue;
			expect(config[field as keyof typeof scalarFieldDefaults]).toBe(expected);
		}
	});

	it('llm 段默认值：visionDetail=low，其余字段未设置（交由环境变量回退）', () => {
		const config = loadConfig();
		expect(config.llm.openai.visionDetail).toBe('low');
		expect(config.llm.openai.apiBase).toBeUndefined();
		expect(config.llm.openai.model).toBeUndefined();
		expect(config.llm.anthropic).toBeUndefined();
	});

	it('llm.openai 段从 TOML 读取并覆盖默认 visionDetail', () => {
		writeConfigToml('[llm.openai]\napiBase = "https://my.proxy/v1"\nmodel = "gpt-5.4-mini"\nvisionDetail = "high"\n');
		const config = loadConfig();
		expect(config.llm.openai.apiBase).toBe('https://my.proxy/v1');
		expect(config.llm.openai.model).toBe('gpt-5.4-mini');
		expect(config.llm.openai.visionDetail).toBe('high');
	});

	it('llm.openai 部分字段：已设置取配置，缺失保持 undefined（环境变量回退）', () => {
		writeConfigToml('[llm.openai]\napiBase = "https://my.proxy/v1"\n');
		const config = loadConfig();
		expect(config.llm.openai.apiBase).toBe('https://my.proxy/v1');
		expect(config.llm.openai.model).toBeUndefined();
		// visionDetail 仍取默认值（配置唯一来源，无环境变量回退）
		expect(config.llm.openai.visionDetail).toBe('low');
	});
});
