import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';

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
});
