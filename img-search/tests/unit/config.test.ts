import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';

const origEnvDbDir = process.env.IMGSEARCH_DB_DIR;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'img-search-config-'));
	process.env.IMGSEARCH_DB_DIR = dir;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (origEnvDbDir === undefined) {
		delete process.env.IMGSEARCH_DB_DIR;
	} else {
		process.env.IMGSEARCH_DB_DIR = origEnvDbDir;
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
			join(dir, 'config.toml'),
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
		writeFileSync(join(dir, 'config.toml'), 'beamSize = [1,');
		expect(() => loadConfig()).toThrow(/配置文件解析失败/);
	});

	it('类型错误抛 ConfigError', () => {
		writeFileSync(join(dir, 'config.toml'), 'lambda = "abc"\n');
		expect(() => loadConfig()).toThrow(/配置文件校验失败/);
	});
});