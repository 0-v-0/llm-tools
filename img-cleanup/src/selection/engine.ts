import type { LLMProvider } from '@llm-image/shared';
import type { ImageEntry } from '../storage/types.js';
import type { AppConfig } from '../config/config.js';
import { groupImages } from '../grouping/grouping.js';
import { createBatches, needsLlm } from '../grouping/batching.js';
import { selectFromBatch, type BatchResult } from './batch-select.js';
import { runTournament, type TournamentRound } from './tournament.js';
import type { Checkpoint } from '../checkpoint/index.js';

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
	/** Batches whose verdict came from the checkpoint cache (no LLM call). */
	reusedBatches: number;
	/** LLM calls actually made in this run (batch + tournament). */
	llmCalls: number;
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

export interface PipelineOptions {
	/**
	 * 中断恢复句柄。提供时每个 LLM 裁决都会即时落盘，并在 url 集合命中时跳过调用。
	 */
	checkpoint?: Checkpoint;
	onProgress?: (msg: string) => void;
}

/**
 * Run the full cleanup pipeline:
 *
 * 1. Group by (standard_name, max_value bucket)
 * 2. Within each group, form batches of n
 * 3. LLM picks 1 "most worth keeping" per batch → losers = the rest
 * 4. If total losers > m: tournament elimination until ≤ m
 * 5. Return the final removal set
 *
 * Grouping/batching is recomputed every run (deterministic given the DB
 * snapshot); only the expensive LLM verdicts are cached. This is what makes
 * `m` / `targetDir` / `batchSize` / `bucketBoundaries` / `--path` changes reuse
 * prior work: the cache is keyed by the compared URL-set, not by batch index.
 */
export async function runCleanupPipeline(
	images: ImageEntry[],
	m: number,
	config: AppConfig,
	provider: LLMProvider,
	options: PipelineOptions = {},
): Promise<CleanupResult> {
	const { checkpoint, onProgress } = options;
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

	// Phase 2: Batch + LLM select (verdicts served from / written to cache)
	const allBatchResults: BatchResult[] = [];
	let reusedBatches = 0;
	let llmCalls = 0;

	for (const [gIdx, group] of groups.entries()) {
		onProgress?.(
			`处理分组 [${group.standardName} / ${group.bucketLabel}] (${group.images.length} 张)`,
		);
		const batches = createBatches(group.images, n);
		groupSummary[gIdx]!.batchCount = batches.length;

		for (const batch of batches) {
			if (!needsLlm(batch)) {
				// Auto-keep single-image batches (no LLM call)
				const { result } = await selectFromBatch(batch, provider, config.maxImageDimension);
				allBatchResults.push(result);
				continue;
			}

			const { result, reused } = await selectFromBatch(
				batch,
				provider,
				config.maxImageDimension,
				checkpoint,
			);
			allBatchResults.push(result);
			if (reused) {
				reusedBatches++;
				onProgress?.(
					`  批次命中缓存 → 保留 [${result.kept.url.split(/[/\\]/).pop()}]，淘汰 ${result.losers.length} 张`,
				);
			} else {
				llmCalls++;
				onProgress?.(
					`  批次比较 (${batch.images.length} 张) → 保留 [${result.kept.url.split(/[/\\]/).pop()}]，淘汰 ${result.losers.length} 张`,
				);
			}
		}
	}

	// Collect all losers
	const allLosers: ImageEntry[] = [];
	for (const result of allBatchResults) {
		allLosers.push(...result.losers);
	}

	onProgress?.(`批次阶段完成：共 ${allLosers.length} 张落选者（复用 ${reusedBatches} 批次）`);

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
		const before = checkpoint?.recordedCount ?? 0;
		const outcome = await runTournament(allLosers, m, provider, config.maxImageDimension, checkpoint);
		if (checkpoint) llmCalls += checkpoint.recordedCount - before;
		toRemove = outcome.survivors;
		tournamentRounds = outcome.rounds;
		onProgress?.(
			`锦标赛完成：${tournamentRounds.length} 轮，最终移走 ${toRemove.length} 张`,
		);
	}

	// Persist the selection outcome so a later move-phase resume can detect it.
	checkpoint?.setToRemoveUrls(toRemove.map((i) => i.url));

	return {
		toRemove,
		totalImages: images.length,
		totalLosers: allLosers.length,
		tournamentUsed,
		tournamentRounds,
		batchResults: allBatchResults,
		groups: groupSummary,
		reusedBatches,
		llmCalls,
	};
}
