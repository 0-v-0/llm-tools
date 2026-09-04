export { CHECKPOINT_VERSION, type CheckpointData, type Verdict } from './types.ts';
export {
	hashStrings,
	sha256Hex,
	verdictKey,
	computeCacheKey,
	BATCH_PROMPT_VERSION,
} from './fingerprint.ts';
export {
	loadCheckpoint,
	saveCheckpoint,
	clearCheckpoint,
	invalidateCheckpoint,
	Checkpoint,
	imageSetHash,
} from './store.ts';
export { confirmForcedReuse, type ConfirmPrompt, defaultPrompt } from './confirm.ts';
export {
	resolveCheckpointPath,
	cacheKeyFor,
	resolveCheckpoint,
	type RunInputs,
	type ResolveResult,
} from './resolve.ts';
