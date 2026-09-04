import { z } from 'zod';

/** 当前 checkpoint 版本号；不兼容变更时递增（旧文件直接作废）。 */
export const CHECKPOINT_VERSION = 1 as const;

/**
 * 一次 LLM 视觉比较的裁决结果。
 *
 * 以「参与比较的 url 集合」为主键缓存，与分组/批次划分方式解耦：
 * 只要某组图片的 url 集合不变，其裁决结果就与 `m`、`targetDir`、
 * `batchSize`、`bucketBoundaries`、`pathGlobs` 无关，可安全复用。
 */
export const VerdictSchema = z.object({
	/** 参与比较的 url（已排序，作为缓存主键的规范化形式）。 */
	urls: z.array(z.string()).min(1),
	/** LLM 选出「最值得保留」的那张。 */
	keptUrl: z.string(),
	/** 落选者（batch: n-1 张；tournament pair: 1 张）。 */
	loserUrls: z.array(z.string()),
	/** LLM 给出的理由（审计用）。 */
	reason: z.string(),
	/** 产生该裁决的阶段。 */
	phase: z.enum(['batch', 'tournament']),
});

export type Verdict = z.infer<typeof VerdictSchema>;

/** 移动阶段的单条结果（与 mover.ts 的 MoveResult 同构，可 JSON 序列化）。 */
export const PersistedMoveResultSchema = z.object({
	path: z.string(),
	targetPath: z.string().optional(),
	status: z.enum(['moved', 'dry-run', 'skipped', 'failed']),
	error: z.string().optional(),
});

export type PersistedMoveResult = z.infer<typeof PersistedMoveResultSchema>;

/**
 * Checkpoint 文件结构。
 *
 * 核心是 `verdicts`（LLM 裁决缓存）；`move` 记录移动进度；
 * `params` 仅用于展示、失配判断与 standard 变更确认。
 */
export const CheckpointDataSchema = z.object({
	version: z.literal(CHECKPOINT_VERSION),
	createdAt: z.string(),
	updatedAt: z.string(),
	/**
	 * 裁决缓存的有效性键：judge（provider/model）+ 图像预处理参数 + prompt 版本。
	 * 变化意味着「裁判换了」，旧裁决不可信 → 整体作废。
	 */
	cacheKey: z.string(),
	params: z.object({
		/** 解析后的目标移走数量。 */
		m: z.number().int().min(0),
		/** 原始 m 参数（如 "10%"）。 */
		mArg: z.string(),
		/** 参与比较的图片总数（快照时）。 */
		totalImages: z.number().int().min(0),
		batchSize: z.number().int().min(2),
		bucketBoundaries: z.array(z.number().nonnegative()),
		pathGlobs: z.array(z.string()),
		standardName: z.string().nullable(),
		targetDir: z.string(),
		dryRun: z.boolean(),
		/** 快照时 sorted image urls 的 hash，用于判断图片集合是否变化。 */
		imageSetHash: z.string(),
	}),
	/** LLM 裁决缓存（按完成顺序追加）。 */
	verdicts: z.array(VerdictSchema),
	/** 选择阶段完成后的最终待移走 url 集合（用于判断 move 是否需重置）。 */
	toRemoveUrls: z.array(z.string()).nullable(),
	/** 移动进度（仅在选择完成后写入）。 */
	move: z
		.object({
			targetDir: z.string(),
			results: z.array(PersistedMoveResultSchema),
			nextIndex: z.number().int().min(0),
		})
		.nullable(),
	completed: z.boolean(),
});

export type CheckpointData = z.infer<typeof CheckpointDataSchema>;
