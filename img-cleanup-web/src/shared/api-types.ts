/** client/server 共享的 API DTO 类型（与 img-cleanup 内部类型解耦，纯 JSON 可序列化）。 */

export interface ImageDTO {
	/** 存储的解码 file URL（imgval.db 原始形式）。 */
	url: string;
	/** 展示用文件名。 */
	name: string;
	format: string;
	width: number;
	height: number;
	sizeBytes: number;
	maxValue: number;
	minValue: number;
	standardName: string;
	undecodablePixels: number;
}

export type BatchStatus = 'pending' | 'decided';

/** 裁决来源：llm=本次 LLM 调用；cache=checkpoint 缓存命中；manual=人工选择；auto-keep=单张自动保留。 */
export type DecisionSource = 'llm' | 'cache' | 'manual' | 'auto-keep';

export interface BatchDTO {
	index: number;
	groupIndex: number;
	status: BatchStatus;
	source?: DecisionSource;
	images: ImageDTO[];
	keptUrl?: string;
	loserUrls?: string[];
	reason?: string;
	/** 本批次处理失败信息（auto/run-remaining 时逐批捕获）。 */
	error?: string;
}

export interface GroupDTO {
	standardName: string;
	bucketLabel: string;
	imageCount: number;
	batchCount: number;
}

export interface TournamentPairDTO {
	kept: string;
	eliminated: string;
	reason: string;
}

export interface TournamentRoundDTO {
	round: number;
	pairs: TournamentPairDTO[];
	byes: string[];
}

export interface MoveResultDTO {
	path: string;
	targetPath?: string;
	status: 'moved' | 'dry-run' | 'skipped' | 'failed';
	error?: string;
}

export type SessionStatus = 'selecting' | 'finalized' | 'moved';

export interface SessionDTO {
	id: string;
	m: number;
	mArg: string;
	targetDir: string;
	dryRun: boolean;
	onCollision: 'skip' | 'rename' | 'abort';
	totalImages: number;
	batchSize: number;
	groups: GroupDTO[];
	batches: BatchDTO[];
	status: SessionStatus;
	tournamentUsed: boolean;
	tournamentRounds: TournamentRoundDTO[];
	/** 最终待移除图片（finalize 后非空）。 */
	toRemoveImages: ImageDTO[];
	moveResults: MoveResultDTO[];
	notes: string[];
	/** 重赛 / 移动等后台任务的最新失败信息（成功后清空）。 */
	error?: string;
	/** run-remaining 或重赛正在后台执行。 */
	running: boolean;
	/** 文件移动正在执行（期间拒绝一切调整/重赛/再次移动）。 */
	moving: boolean;
}

export interface ConfigDTO {
	batchSize: number;
	maxImageDimension: number;
	bucketBoundaries: number[];
	checkpointEnabled: boolean;
	standards: { name: string; count: number }[];
	totalImages: number;
}

export interface CreateSessionBody {
	mArg: string;
	targetDir: string;
	batchSize?: number;
	pathGlobs?: string[];
	standard?: string;
	dryRun?: boolean;
	onCollision?: 'skip' | 'rename' | 'abort';
}

export interface ManualDecisionBody {
	keptUrl: string;
	reason?: string;
}
