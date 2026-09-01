import type { LLMProvider, LLMMessage, CompleteResponse } from '@llm-image/shared';
import { LLMError } from '@llm-image/shared';
import { processImage } from '@llm-image/shared';
import type { ImageEntry } from '../storage/types.js';
import type { Batch } from '../grouping/batching.js';
import { buildBatchPrompt, labelFor, type PreparedImage } from '../llm/prompt.js';
import { parseSelectionResponse } from '../llm/response-parser.js';

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
 */
export async function selectFromBatch(
	batch: Batch,
	provider: LLMProvider,
	maxImageDimension: number,
): Promise<BatchResult> {
	// Auto-keep if only 1 image
	if (batch.images.length === 1) {
		return {
			batch,
			kept: batch.images[0]!,
			losers: [],
			reason: '批次仅 1 张图片，自动保留',
		};
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

	return {
		batch,
		kept: keptPrepared.entry,
		losers,
		reason: parsed.reason,
	};
}
