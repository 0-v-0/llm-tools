import type { LLMProvider, LLMMessage, CompleteResponse } from '@llm-image/shared';
import { LLMError } from '@llm-image/shared';
import { processImage } from '@llm-image/shared';
import type { ImageEntry } from '../storage/types.js';
import type { Batch } from '../grouping/batching.js';
import { buildBatchPrompt, labelFor, type PreparedImage } from '../llm/prompt.js';
import { parseSelectionResponse } from '../llm/response-parser.js';
import type { Checkpoint, Verdict } from '../checkpoint/index.js';

export interface BatchResult {
	/** The batch that was evaluated. */
	batch: Batch;
	/** The image the LLM chose to keep. */
	kept: ImageEntry;
	/** Images not chosen (candidates for removal). */
	losers: ImageEntry[];
	/** The LLM's reason. */
	reason: string;
}

/**
 * For a single batch, call the LLM to pick 1 "most worth keeping".
 * Returns the kept image and the losers (n-1 images).
 *
 * Batches with 1 image are auto-kept (no LLM call).
 *
 * @param checkpoint Optional verdict cache. On a cache hit keyed by the batch's
 *   URL-set, the LLM call is skipped and the cached kept/losers are returned.
 *   Cache misses call the LLM and record the new verdict.
 */
export async function selectFromBatch(
	batch: Batch,
	provider: LLMProvider,
	maxImageDimension: number,
	checkpoint?: Checkpoint,
): Promise<{ result: BatchResult; reused: boolean }> {
	// Auto-keep if only 1 image (no LLM call, no caching needed)
	if (batch.images.length === 1) {
		return {
			result: {
				batch,
				kept: batch.images[0]!,
				losers: [],
				reason: '批次仅 1 张图片，自动保留',
			},
			reused: false,
		};
	}

	// Cache lookup before any image processing / LLM call
	const urls = batch.images.map((i) => i.url);
	if (checkpoint) {
		const hit = checkpoint.lookup(urls);
		if (hit) {
			const restored = restoreFromVerdict(batch, hit);
			if (restored) return { result: restored, reused: true };
		}
	}

	// Process all images (load, resize, base64)
	const prepared: PreparedImage[] = [];
	for (let i = 0; i < batch.images.length; i++) {
		const entry = batch.images[i]!;
		const processed = await processImage(entry.url, maxImageDimension);
		prepared.push({ entry, processed, label: labelFor(i) });
	}

	// Build prompt
	const { systemPrompt, userMessages } = buildBatchPrompt(prepared);

	// Call LLM
	const messages: LLMMessage[] = [
		{ role: 'system', content: systemPrompt },
		...userMessages,
	];

	const resp: CompleteResponse = await provider.complete({
		model: provider.model,
		messages,
		temperature: 0,
	});

	// Parse response
	const parsed = parseSelectionResponse(resp.text);

	// Find the kept image by label
	const keptPrepared = prepared.find((p) => p.label === parsed.selected);
	if (!keptPrepared) {
		throw new LLMError(
			`LLM 选择了无效的标签 "${parsed.selected}"，有效标签: ${prepared.map((p) => p.label).join(', ')}`,
		);
	}

	const losers = prepared
		.filter((p) => p.label !== parsed.selected)
		.map((p) => p.entry);

	const result: BatchResult = {
		batch,
		kept: keptPrepared.entry,
		losers,
		reason: parsed.reason,
	};

	if (checkpoint) {
		checkpoint.record({
			urls: [...urls].sort(),
			keptUrl: result.kept.url,
			loserUrls: result.losers.map((l) => l.url),
			reason: result.reason,
			phase: 'batch',
		});
	}

	return { result, reused: false };
}

/**
 * Restore a BatchResult from a cached verdict.
 * Returns null when the verdict references URLs no longer in the batch.
 */
function restoreFromVerdict(batch: Batch, verdict: Verdict): BatchResult | null {
	const byUrl = new Map(batch.images.map((i) => [i.url, i]));
	const kept = byUrl.get(verdict.keptUrl);
	if (!kept) return null;
	const losers: ImageEntry[] = [];
	for (const u of verdict.loserUrls) {
		const e = byUrl.get(u);
		if (!e) return null;
		losers.push(e);
	}
	return { batch, kept, losers, reason: verdict.reason };
}
