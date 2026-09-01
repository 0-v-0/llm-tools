import type { LLMProvider } from '@llm-image/shared';
import { LLMError } from '@llm-image/shared';
import { processImage } from '@llm-image/shared';
import type { ImageEntry } from '../storage/types.js';
import { buildBatchPrompt, labelFor, type PreparedImage } from '../llm/prompt.js';
import { parseSelectionResponse } from '../llm/response-parser.js';

export interface TournamentRound {
	round: number;
	/** Pairs evaluated this round. */
	pairs: Array<{
		pair: [ImageEntry, ImageEntry];
		/** The image the LLM chose to keep (removed from removal candidates). */
		kept: ImageEntry;
		/** The image that remains a removal candidate. */
		eliminated: ImageEntry;
		reason: string;
	}>;
	/** Images that got a bye (odd count) — auto-kept, removed from candidates. */
	byes: ImageEntry[];
}

/**
 * Tournament elimination: reduce a set of removal candidates to ≤ m.
 *
 * In each round:
 * 1. Pair up candidates (A, B), (C, D), ...
 * 2. For each pair, LLM picks 1 to KEEP → the other stays as a removal candidate
 * 3. If odd count, the last one gets a "bye" (auto-kept, removed from candidates)
 * 4. Repeat until candidates ≤ m
 *
 * The tournament always uses pairs (n=2), regardless of the configured batch size.
 *
 * Returns the final set of removal candidates (≤ m) and the round history.
 */
export async function runTournament(
	candidates: ImageEntry[],
	m: number,
	provider: LLMProvider,
	maxImageDimension: number,
): Promise<{ survivors: ImageEntry[]; rounds: TournamentRound[] }> {
	let current = [...candidates];
	const rounds: TournamentRound[] = [];
	let roundNum = 0;

	while (current.length > m) {
		roundNum++;
		const pairs: TournamentRound['pairs'] = [];
		const byes: ImageEntry[] = [];

		// Pair up
		for (let i = 0; i + 1 < current.length; i += 2) {
			const a = current[i]!;
			const b = current[i + 1]!;
			const result = await comparePair(a, b, provider, maxImageDimension);
			pairs.push(result);
		}

		// Odd one out gets a bye
		if (current.length % 2 === 1) {
			byes.push(current[current.length - 1]!);
		}

		rounds.push({ round: roundNum, pairs, byes });

		// Survivors = the ones NOT kept (the "eliminated" from each pair)
		current = pairs.map((p) => p.eliminated);
	}

	return { survivors: current, rounds };
}

/**
 * Compare a pair: LLM picks 1 to keep, the other is the "eliminated"
 * (stays as a removal candidate).
 */
async function comparePair(
	a: ImageEntry,
	b: ImageEntry,
	provider: LLMProvider,
	maxImageDimension: number,
): Promise<{
	pair: [ImageEntry, ImageEntry];
	kept: ImageEntry;
	eliminated: ImageEntry;
	reason: string;
}> {
	// Process both images
	const preparedA: PreparedImage = {
		entry: a,
		processed: await processImage(a.url, maxImageDimension),
		label: labelFor(0),
	};
	const preparedB: PreparedImage = {
		entry: b,
		processed: await processImage(b.url, maxImageDimension),
		label: labelFor(1),
	};

	const { systemPrompt, userMessages } = buildBatchPrompt([preparedA, preparedB]);

	const resp = await provider.complete({
		model: provider.model,
		messages: [
			{ role: 'system', content: systemPrompt },
			...userMessages,
		],
		temperature: 0,
	});

	const parsed = parseSelectionResponse(resp.text);

	const keptPrepared = [preparedA, preparedB].find((p) => p.label === parsed.selected);
	if (!keptPrepared) {
		throw new LLMError(
			`LLM 选择了无效的标签 "${parsed.selected}"，有效标签: A, B`,
		);
	}

	const kept = keptPrepared.entry;
	const eliminated = kept === a ? b : a;

	return { pair: [a, b], kept, eliminated, reason: parsed.reason };
}
