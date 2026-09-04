export { CHECKPOINT_VERSION, type CheckpointData, type Verdict } from './types.js';
export {
	hashStrings,
	sha256Hex,
	verdictKey,
	computeCacheKey,
	BATCH_PROMPT_VERSION,
} from './fingerprint.js';
export {
	loadCheckpoint,
	saveCheckpoint,
	clearCheckpoint,
	invalidateCheckpoint,
	Checkpoint,
	imageSetHash,
} from './store.js';
export { confirmForcedReuse, type ConfirmPrompt, defaultPrompt } from './confirm.js';
export {
	resolveCheckpointPath,
	cacheKeyFor,
	resolveCheckpoint,
	type RunInputs,
	type ResolveResult,
} from './resolve.js';
