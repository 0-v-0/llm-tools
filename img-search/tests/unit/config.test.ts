import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';

const origEnvDbDir = process.env.IMGDATA_DIR;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'img-search-config-'));
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
		expect(config.alpha).toBe(0.5);
		expect(config.lambda).toBe(8);
		expect(config.beamSize).toBe(500);
		expect(config.topKQuestions).toBe(50);
		expect(config.candidateQuestions).toBe(5);
		expect(config.igThreshold).toBe(0.05);
		expect(config.maxRounds).toBe(8);
		expect(config.minRounds).toBe(2);
		expect(config.showThumbnails).toBe(false);
		expect(config.maxImageDimension).toBe(512);
		expect(config.importConcurrency).toBe(4);
		expect(config.embedTextBatch).toBe(64);
		expect(config.embedImageBatch).toBe(16);
	});

	it('读取并校验有效 TOML 配置', () => {
		writeFileSync(
			join(dir, 'imgsearch.toml'),
			'alpha = 0.3\nlambda = 16\nbeamSize = 100\ntopKQuestions = 20\ncandidateQuestions = 3\nigThreshold = 0.1\nmaxRounds = 12\nminRounds = 3\nshowThumbnails = true\nmaxImageDimension = 1024\nimportConcurrency = 2\nembedTextBatch = 32\nembedImageBatch = 8\n',
		);
		const config = loadConfig();
		expect(config.alpha).toBe(0.3);
		expect(config.lambda).toBe(16);
		expect(config.beamSize).toBe(100);
		expect(config.topKQuestions).toBe(20);
		expect(config.candidateQuestions).toBe(3);
		expect(config.igThreshold).toBe(0.1);
		expect(config.maxRounds).toBe(12);
		expect(config.minRounds).toBe(3);
		expect(config.showThumbnails).toBe(true);
		expect(config.maxImageDimension).toBe(1024);
		expect(config.importConcurrency).toBe(2);
		expect(config.embedTextBatch).toBe(32);
		expect(config.embedImageBatch).toBe(8);
	});

	it('非法 TOML 抛 ConfigError', () => {
		writeFileSync(join(dir, 'imgsearch.toml'), 'beamSize = [1,');
		expect(() => loadConfig()).toThrow(/配置文件解析失败/);
	});

	it('类型错误抛 ConfigError', () => {
		writeFileSync(join(dir, 'imgsearch.toml'), 'lambda = "abc"\n');
		expect(() => loadConfig()).toThrow(/配置文件校验失败/);
	});

	it('llm 段默认值：visionDetail=low，其余字段未设置（交由环境变量回退）', () => {
		const config = loadConfig();
		expect(config.llm.openai.visionDetail).toBe('low');
		expect(config.llm.openai.apiBase).toBeUndefined();
		expect(config.llm.openai.model).toBeUndefined();
		expect(config.llm.anthropic).toBeUndefined();
	});

	it('llm.openai 段从 TOML 读取并覆盖默认 visionDetail', () => {
		writeFileSync(
			join(dir, 'imgsearch.toml'),
			'[llm.openai]\napiBase = "https://my.proxy/v1"\nmodel = "gpt-4o-mini"\nvisionDetail = "high"\n',
		);
		const config = loadConfig();
		expect(config.llm.openai.apiBase).toBe('https://my.proxy/v1');
		expect(config.llm.openai.model).toBe('gpt-4o-mini');
		expect(config.llm.openai.visionDetail).toBe('high');
	});

	it('llm.openai 部分字段：已设置取配置，缺失保持 undefined（环境变量回退）', () => {
		writeFileSync(join(dir, 'imgsearch.toml'), '[llm.openai]\napiBase = "https://my.proxy/v1"\n');
		const config = loadConfig();
		expect(config.llm.openai.apiBase).toBe('https://my.proxy/v1');
		expect(config.llm.openai.model).toBeUndefined();
		// visionDetail 仍取默认值（配置唯一来源，无环境变量回退）
		expect(config.llm.openai.visionDetail).toBe('low');
	});
});
