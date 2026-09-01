import type { LLMProvider } from '@llm-image/shared';
import type { ImageEntry } from '../storage/types.js';
import type { AppConfig } from '../config/config.js';
import { groupImages } from '../grouping/grouping.js';
import { createBatches, needsLlm, type Batch } from '../grouping/batching.js';
import { selectFromBatch, type BatchResult } from './batch-select.js';
import { runTournament, type TournamentRound } from './tournament.js';

export interface CleanupPhase {
	name: string;
	detail: string;
}

export interface CleanupResult {
	/** Images to be moved (final removal set, ≤ m). */
	toRemove: ImageEntry[];
	/** Total distinct files in the DB (matching filters). */
	totalImages: number;
	/** Total losers from batch phase. */
	totalLosers: number;
	/** Whether tournament was needed. */
	tournamentUsed: boolean;
	/** Tournament rounds (empty if no tournament). */
	tournamentRounds: TournamentRound[];
	/** Batch results from the first phase. */
	batchResults: BatchResult[];
	/** Groups processed. */
	groups: { standardName: string; bucketLabel: string; imageCount: number; batchCount: number }[];
}

/**
 * Parse the m argument: "50" → absolute, "10%" → percentage of total.
 */
export function parseM(mArg: string, totalImages: number): number {
	const pctMatch = mArg.match(/^(\d+(?:\.\d+)?)%$/);
	if (pctMatch) {
		const pct = parseFloat(pctMatch[1]!);
		if (pct <= 0 || pct > 100) {
			throw new Error(`百分比须在 0~100 之间: ${mArg}`);
		}
		return Math.ceil((totalImages * pct) / 100);
	}
	const m = parseInt(mArg, 10);
	if (!Number.isFinite(m) || m < 0) {
		throw new Error(`无效的数量: ${mArg}`);
	}
	return m;
}

/**
 * Run the full cleanup pipeline:
 *
 * 1. Query all distinct files from imgval.db
 * 2. Group by (standard_name, max_value bucket)
 * 3. Within each group, form batches of n
 * 4. LLM picks 1 "most worth keeping" per batch → losers = the rest
 * 5. If total losers > m: tournament elimination until ≤ m
 * 6. Return the final removal set
 *
 * The `onProgress` callback is called for each phase and batch for UI feedback.
 */
export async function runCleanupPipeline(
	images: ImageEntry[],
	m: number,
	config: AppConfig,
	provider: LLMProvider,
	onProgress?: (msg: string) => void,
): Promise<CleanupResult> {
	const n = config.batchSize;
	const boundaries = config.bucketBoundaries;

	// Phase 1: Group
	onProgress?.(`分组：按估值标准和价格区间分桶...`);
	const groups = groupImages(images, boundaries);
	const groupSummary = groups.map((g) => ({
		standardName: g.standardName,
		bucketLabel: g.bucketLabel,
		imageCount: g.images.length,
		batchCount: 0,
	}));
	onProgress?.(`共 ${groups.length} 个分组（${images.length} 张图片）`);

	// Phase 2: Batch + LLM select
	const allBatchResults: BatchResult[] = [];
	for (const group of groups) {
		onProgress?.(
			`处理分组 [${group.standardName} / ${group.bucketLabel}] (${group.images.length} 张)`,
		);
		const batches = createBatches(group.images, n);
		const gIdx = groupSummary.findIndex(
			(g) => g.standardName === group.standardName && g.bucketLabel === group.bucketLabel,
		);
		if (gIdx >= 0) groupSummary[gIdx]!.batchCount = batches.length;

		for (const batch of batches) {
			if (!needsLlm(batch)) {
				// Auto-keep single-image batches
				const result = await selectFromBatch(batch, provider, config.maxImageDimension);
				allBatchResults.push(result);
			} else {
				onProgress?.(`  批次比较 (${batch.images.length} 张)...`);
				const result = await selectFromBatch(batch, provider, config.maxImageDimension);
				allBatchResults.push(result);
				onProgress?.(
					`  → 保留 [${result.kept.url.split(/[/\\]/).pop()}]，淘汰 ${result.losers.length} 张`,
				);
			}
		}
	}

	// Collect all losers
	const allLosers: ImageEntry[] = [];
	for (const result of allBatchResults) {
		allLosers.push(...result.losers);
	}

	onProgress?.(`批次阶段完成：共 ${allLosers.length} 张落选者`);

	// Phase 3: Tournament if needed
	let toRemove: ImageEntry[];
	let tournamentRounds: TournamentRound[] = [];
	let tournamentUsed = false;

	if (allLosers.length <= m) {
		// Fewer losers than m — move all, report actual count
		toRemove = allLosers;
		onProgress?.(
			allLosers.length < m
				? `落选者 (${allLosers.length}) 少于目标 ${m}，将移走全部落选者`
				: `落选者 (${allLosers.length}) 等于目标 ${m}，无需锦标赛`,
		);
	} else {
		// Tournament elimination
		tournamentUsed = true;
		onProgress?.(`落选者 (${allLosers.length}) 超过目标 ${m}，启动锦标赛淘汰...`);
		const result = await runTournament(allLosers, m, provider, config.maxImageDimension);
		toRemove = result.survivors;
		tournamentRounds = result.rounds;
		onProgress?.(
			`锦标赛完成：${tournamentRounds.length} 轮，最终移走 ${toRemove.length} 张`,
		);
	}

	return {
		toRemove,
		totalImages: images.length,
		totalLosers: allLosers.length,
		tournamentUsed,
		tournamentRounds,
		batchResults: allBatchResults,
		groups: groupSummary,
	};
}
