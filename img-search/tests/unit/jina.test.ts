import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMError } from "@llm-image/shared";
import { JinaEmbeddingProvider } from "../../src/embedding/jina.ts";

const CONFIG = {
	apiKey: "test-key",
	model: "jina-clip-v2",
	apiBase: "https://api.jina.ai/v1",
	dimensions: 4,
	textBatchSize: 2,
	imageBatchSize: 2,
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function embeddingResponse(embeddings: number[][]): Response {
	return jsonResponse({
		data: embeddings.map((embedding, index) => ({ embedding, index })),
		model: CONFIG.model,
		usage: { prompt_tokens: 1, total_tokens: 1 },
	});
}

interface CapturedRequest {
	url: string;
	init?: RequestInit;
	body: { model: string; input: Record<string, string>[]; dimensions: number };
}

/** Stub global fetch; returns the mock plus the parsed request bodies it received. */
function stubFetch(impl: (captured: CapturedRequest) => Response | Promise<Response>) {
	const requests: CapturedRequest[] = [];
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const captured: CapturedRequest = {
			url: String(url),
			init,
			body: JSON.parse(String(init?.body)),
		};
		requests.push(captured);
		return impl(captured);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, requests };
}

describe("JinaEmbeddingProvider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("batches embedText by textBatchSize and concatenates results in order", async () => {
		// 5 texts with batchSize 2 -> 3 calls with input sizes [2, 2, 1]
		const { requests } = stubFetch((captured) =>
			embeddingResponse(captured.body.input.map(() => [1, 0, 0, 0])),
		);
		const provider = new JinaEmbeddingProvider(CONFIG);
		const texts = ["a", "b", "c", "d", "e"];

		const result = await provider.embedText(texts);

		expect(requests).toHaveLength(3);
		expect(requests.map((r) => r.body.input.length)).toEqual([2, 2, 1]);
		// Each call sends { text } inputs in slice order
		expect(requests[0]?.body.input).toEqual([{ text: "a" }, { text: "b" }]);
		expect(requests[1]?.body.input).toEqual([{ text: "c" }, { text: "d" }]);
		expect(requests[2]?.body.input).toEqual([{ text: "e" }]);
		expect(result).toHaveLength(5);
		for (const v of result) {
			expect(v).toBeInstanceOf(Float32Array);
			expect(Array.from(v)).toEqual([1, 0, 0, 0]);
		}
	});

	it("restores output order from the index field even when response data is shuffled", async () => {
		// Response returns index 1 before index 0; sort-by-index contract must fix the order
		stubFetch(() =>
			jsonResponse({
				data: [
					{ embedding: [2, 2, 2, 2], index: 1 },
					{ embedding: [1, 1, 1, 1], index: 0 },
				],
				model: CONFIG.model,
				usage: { prompt_tokens: 1, total_tokens: 1 },
			}),
		);
		const provider = new JinaEmbeddingProvider(CONFIG);

		const result = await provider.embedText(["first", "second"]);

		expect(result).toHaveLength(2);
		expect(Array.from(result[0]!)).toEqual([1, 1, 1, 1]);
		expect(Array.from(result[1]!)).toEqual([2, 2, 2, 2]);
	});

	it("batches embedImage by imageBatchSize and sends { image } inputs", async () => {
		const { requests } = stubFetch((captured) =>
			embeddingResponse(captured.body.input.map(() => [0, 1, 0, 0])),
		);
		const provider = new JinaEmbeddingProvider(CONFIG);
		const images = [
			"data:image/png;base64,AAAA",
			"data:image/png;base64,BBBB",
			"data:image/png;base64,CCCC",
			"data:image/png;base64,DDDD",
			"data:image/png;base64,EEEE",
		];

		const result = await provider.embedImage(images);

		expect(requests).toHaveLength(3);
		expect(requests.map((r) => r.body.input.length)).toEqual([2, 2, 1]);
		expect(requests[0]?.body.input).toEqual([{ image: images[0] }, { image: images[1] }]);
		expect(requests[2]?.body.input).toEqual([{ image: images[4] }]);
		expect(result).toHaveLength(5);
		for (const v of result) {
			expect(Array.from(v)).toEqual([0, 1, 0, 0]);
		}
	});

	it("returns empty result without calling fetch for empty inputs", async () => {
		const { fetchMock } = stubFetch(() => embeddingResponse([]));
		const provider = new JinaEmbeddingProvider(CONFIG);

		expect(await provider.embedText([])).toEqual([]);
		expect(await provider.embedImage([])).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("throws LLMError with status and body on HTTP 500", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Internal Server Error", { status: 500 })),
		);
		const provider = new JinaEmbeddingProvider(CONFIG);

		await expect(provider.embedText(["a"])).rejects.toThrow(LLMError);
		await expect(provider.embedText(["a"])).rejects.toThrow(/500/);
		await expect(provider.embedText(["a"])).rejects.toThrow(/Internal Server Error/);
	});

	it("throws LLMError with 网络错误 when fetch rejects", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("boom"))));
		const provider = new JinaEmbeddingProvider(CONFIG);

		await expect(provider.embedText(["a"])).rejects.toThrow(LLMError);
		await expect(provider.embedText(["a"])).rejects.toThrow(/网络错误/);
		await expect(provider.embedText(["a"])).rejects.toThrow(/boom/);
	});

	it("throws LLMError 响应解析失败 when a 200 response has a non-JSON body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("<html>Bad Gateway</html>", { status: 200 })),
		);
		const provider = new JinaEmbeddingProvider(CONFIG);

		await expect(provider.embedText(["a"])).rejects.toThrow(LLMError);
		await expect(provider.embedText(["a"])).rejects.toThrow("响应解析失败");
	});

	it("throws LLMError 响应不完整 when data length does not match inputs length", async () => {
		// 2 inputs, only 1 embedding returned
		stubFetch(() =>
			jsonResponse({
				data: [{ embedding: [1, 1, 1, 1], index: 0 }],
				model: CONFIG.model,
				usage: { prompt_tokens: 1, total_tokens: 1 },
			}),
		);
		const provider = new JinaEmbeddingProvider(CONFIG);

		await expect(provider.embedText(["a", "b"])).rejects.toThrow(LLMError);
		await expect(provider.embedText(["a", "b"])).rejects.toThrow("响应不完整");
	});

	it("throws LLMError when an element is missing its embedding array", async () => {
		stubFetch(() =>
			jsonResponse({
				data: [{ index: 0 }],
				model: CONFIG.model,
				usage: { prompt_tokens: 1, total_tokens: 1 },
			}),
		);
		const provider = new JinaEmbeddingProvider(CONFIG);
		await expect(provider.embedText(["a"])).rejects.toThrow(/embedding/);
	});

	it("throws LLMError when an element embedding is not an array", async () => {
		stubFetch(() =>
			jsonResponse({
				data: [{ embedding: "not-an-array", index: 0 }],
				model: CONFIG.model,
				usage: { prompt_tokens: 1, total_tokens: 1 },
			}),
		);
		const provider = new JinaEmbeddingProvider(CONFIG);
		await expect(provider.embedText(["a"])).rejects.toThrow(LLMError);
	});

	it("sends an AbortSignal with each request (60s timeout wiring)", async () => {
		const { fetchMock, requests } = stubFetch(() => embeddingResponse([[1, 1, 1, 1]]));
		const provider = new JinaEmbeddingProvider(CONFIG);

		await provider.embedText(["a"]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const init = requests[0]?.init;
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		// Request shape: POST to {apiBase}/embeddings with auth and model/dimensions
		expect(requests[0]?.url).toBe("https://api.jina.ai/v1/embeddings");
		expect(init?.method).toBe("POST");
		expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
		expect(requests[0]?.body.model).toBe("jina-clip-v2");
		expect(requests[0]?.body.dimensions).toBe(4);
	});

	it("returns Float32Array values matching the mock embeddings on the happy path", async () => {
		stubFetch(() => embeddingResponse([[1, 2, 3, 4], [5, 6, 7, 8]]));
		const provider = new JinaEmbeddingProvider(CONFIG);

		const result = await provider.embedText(["a", "b"]);

		expect(result).toHaveLength(2);
		expect(result[0]).toBeInstanceOf(Float32Array);
		expect(Array.from(result[0]!)).toEqual([1, 2, 3, 4]);
		expect(Array.from(result[1]!)).toEqual([5, 6, 7, 8]);
		expect(provider.model).toBe("jina-clip-v2");
		expect(provider.dimensions).toBe(4);
	});
});
