import { ConfigError } from "@llm-image/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../../src/config/env.ts";

/** loadEnv 模式覆盖的全部环境变量键。 */
const ENV_KEYS = [
	"OPENAI_API_BASE",
	"OPENAI_API_KEY",
	"OPENAI_MODEL",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_MODEL",
	"ANTHROPIC_API_BASE",
	"JINA_API_KEY",
	"JINA_MODEL",
	"JINA_API_BASE",
	"JINA_DIMENSIONS",
	"QDRANT_URL",
	"QDRANT_COLLECTION",
	"QDRANT_API_KEY",
	"IMGDATA_DIR",
] as const;

const origEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
	origEnv[key] = process.env[key];
}

beforeEach(() => {
	for (const key of ENV_KEYS) {
		delete process.env[key];
	}
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) {
		const value = origEnv[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

describe("loadEnv", () => {
	it("未设置任何变量时返回默认值", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const env = loadEnv();
		expect(env.JINA_MODEL).toBe("jina-clip-v2");
		expect(env.JINA_API_BASE).toBe("https://api.jina.ai/v1");
		expect(env.JINA_DIMENSIONS).toBe(1024);
		expect(env.QDRANT_URL).toBe("http://localhost:6333");
		expect(env.QDRANT_COLLECTION).toBe("images");
		expect(env.OPENAI_API_BASE).toBe("https://api.openai.com/v1");
		expect(env.OPENAI_MODEL).toBe("gpt-5.6-luna");
		expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
		// 可选字段未设置
		expect(env.IMGDATA_DIR).toBeUndefined();
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.JINA_API_KEY).toBeUndefined();
		expect(env.QDRANT_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_API_BASE).toBeUndefined();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("JINA_DIMENSIONS 从字符串强制转换为数字", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.JINA_DIMENSIONS = "2048";
		const env = loadEnv();
		expect(env.JINA_DIMENSIONS).toBe(2048);
		expect(typeof env.JINA_DIMENSIONS).toBe("number");
	});

	it("非数字 JINA_DIMENSIONS 抛 ConfigError", () => {
		process.env.JINA_DIMENSIONS = "abc";
		expect(() => loadEnv()).toThrow(ConfigError);
		expect(() => loadEnv()).toThrow(/环境变量校验失败/);
		expect(() => loadEnv()).toThrow(/JINA_DIMENSIONS/);
	});

	it("空字符串 IMGDATA_DIR 抛 ConfigError（min(1)）", () => {
		process.env.IMGDATA_DIR = "";
		expect(() => loadEnv()).toThrow(ConfigError);
		expect(() => loadEnv()).toThrow(/环境变量校验失败/);
		expect(() => loadEnv()).toThrow(/IMGDATA_DIR/);
	});
});

describe("不安全传输警告", () => {
	it("QDRANT_API_KEY + http 非本地地址 → 警告", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.QDRANT_API_KEY = "qdrant-secret";
		process.env.QDRANT_URL = "http://example.com";
		loadEnv();
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("QDRANT_API_KEY"));
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("QDRANT_URL"));
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("http://example.com"));
	});

	it("QDRANT_API_KEY + https → 不警告", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.QDRANT_API_KEY = "qdrant-secret";
		process.env.QDRANT_URL = "https://example.com";
		loadEnv();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it.each(["http://localhost:6333", "http://127.0.0.1:6333"])(
		"QDRANT_API_KEY + 本地地址 %s → 不警告",
		(url) => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			process.env.QDRANT_API_KEY = "qdrant-secret";
			process.env.QDRANT_URL = url;
			loadEnv();
			expect(warnSpy).not.toHaveBeenCalled();
		},
	);

	it("JINA_API_KEY + http JINA_API_BASE → 警告", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.JINA_API_KEY = "jina-secret";
		process.env.JINA_API_BASE = "http://jina.example.com";
		loadEnv();
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("JINA_API_KEY"));
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("JINA_API_BASE"));
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("http://jina.example.com"));
	});

	it("OPENAI_API_KEY + http OPENAI_API_BASE → 警告", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.OPENAI_API_KEY = "openai-secret";
		process.env.OPENAI_API_BASE = "http://openai.example.com/v1";
		loadEnv();
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("OPENAI_API_KEY"));
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("OPENAI_API_BASE"));
	});

	it("ANTHROPIC_API_KEY 已设置但 ANTHROPIC_API_BASE 未设置 → 不警告", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.ANTHROPIC_API_KEY = "anthropic-secret";
		const env = loadEnv();
		expect(env.ANTHROPIC_API_BASE).toBeUndefined();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("ANTHROPIC_API_KEY + http ANTHROPIC_API_BASE → 警告", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.ANTHROPIC_API_KEY = "anthropic-secret";
		process.env.ANTHROPIC_API_BASE = "http://anthropic.example.com";
		loadEnv();
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ANTHROPIC_API_KEY"));
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ANTHROPIC_API_BASE"));
	});

	it("未设置任何 API 密钥 → 不警告", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		loadEnv();
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
