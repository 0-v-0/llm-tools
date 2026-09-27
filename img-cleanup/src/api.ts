/**
 * Library API for embedding the cleanup pipeline in other applications
 * (e.g. img-cleanup-web). The CLI (src/index.ts) is a thin wrapper over
 * these primitives — no behaviour lives here, this is a re-export barrel.
 */

// Core data types
export type { ImageEntry } from './storage/types.ts';
export type { Batch } from './grouping/batching.ts';
export type { BatchResult } from './selection/batch-select.ts';
export type {
	TournamentRound,
	TournamentOutcome,
} from './selection/tournament.ts';
export type { CleanupResult, CleanupPhase } from './selection/engine.ts';
export type { MoveResult, MoveOptions } from './move/mover.ts';
export type { ImageGroup } from './grouping/grouping.ts';

// Storage
export {
	getAllImages,
	countDistinctFiles,
	updateRecordUrl,
} from './storage/repository.valuation.ts';
export { getDb, closeDb, setDb } from './storage/db.ts';

// Grouping / batching
export { groupImages, bucketIndexFor, bucketLabel } from './grouping/grouping.ts';
export { createBatches, needsLlm } from './grouping/batching.ts';

// Selection (batch comparison + tournament)
export { selectFromBatch, restoreFromVerdict } from './selection/batch-select.ts';
export { runTournament } from './selection/tournament.ts';
export { runCleanupPipeline, parseM } from './selection/engine.ts';

// Move
export { moveImages, setFileIndexRepo } from './move/mover.ts';

// Checkpoint (中断恢复 / 裁决缓存)
export {
	Checkpoint,
	loadCheckpoint,
	saveCheckpoint,
	clearCheckpoint,
	invalidateCheckpoint,
	imageSetHash,
	verdictKey,
	resolveCheckpoint,
	resolveCheckpointPath,
	cacheKeyFor,
} from './checkpoint/index.ts';
export type {
	CheckpointData,
	Verdict,
	RunInputs,
	ResolveResult,
} from './checkpoint/index.ts';

// Config / env / paths
export { loadConfig, MAX_BATCH_SIZE } from './config/config.ts';
export type { AppConfig } from './config/config.ts';
export { loadEnv } from './config/env.ts';
export type { EnvConfig } from './config/env.ts';
export {
	bootstrap,
	getHomeDir,
	getDbPath,
	getConfigPath,
	getCheckpointPath,
} from './config/paths.ts';

// Local file URL helpers
export { fileUrlToPath, toFileUrl } from './util/url.ts';
