import type { LLMProvider } from '@llm-image/shared';
import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { basename } from 'node:path';
import {
	type AppConfig,
	type Batch,
	type BatchResult,
	Checkpoint,
	clearCheckpoint,
	createBatches,
	countDistinctFiles,
	getAllImages,
	groupImages,
	type ImageEntry,
	type MoveResult,
	moveImages,
	MAX_BATCH_SIZE,
	parseM,
	type ResolveResult,
	resolveCheckpoint,
	restoreFromVerdict,
	runTournament,
	selectFromBatch,
	type TournamentRound,
} from 'img-cleanup/api';
import type {
	BatchDTO,
	CreateSessionBody,
	GroupDTO,
	ImageDTO,
	MoveResultDTO,
	SessionDTO,
	TournamentRoundDTO,
} from '../shared/api-types.ts';
import { HttpError } from './errors.ts';

export interface SessionDeps {
	config: AppConfig;
	/** LLM provider；null = 未配置密钥（手动模式：自动选择/建议/锦标赛禁用）。 */
	provider: LLMProvider | null;
	/** checkpoint 文件路径（checkpointEnabled=false 时忽略）。 */
	checkpointPath: string;
	checkpointEnabled: boolean;
}

interface SessionBatch {
	groupIndex: number;
	batch: Batch;
	status: 'pending' | 'decided';
	source?: BatchDTO['source'] | undefined;
	result?: BatchResult | undefined;
	error?: string | undefined;
}

export class CleanupSession {
	readonly batches: SessionBatch[] = [];
	readonly groups: GroupDTO[] = [];
	readonly urlSet = new Set<string>();
	m!: number;
	status: SessionDTO['status'] = 'selecting';
	tournamentRounds: TournamentRound[] = [];
	tournamentUsed = false;
	toRemove: ImageEntry[] = [];
	moveResults: MoveResult[] = [];
	notes: string[] = [];
	/** 重赛/移动等后台任务的最新失败信息（成功后清空）。 */
	error: string | undefined;
	running = false;
	/** 文件移动正在执行（互斥窗口）。 */
	moving = false;

	private readonly updateListeners = new Set<() => void>();

	/**
	 * 订阅会话状态变更（SSE 推送用）；返回退订函数。
	 * 通知不携带载荷，订阅方按需调用 toDTO()。
	 */
	onUpdate(cb: () => void): () => void {
		this.updateListeners.add(cb);
		return () => this.updateListeners.delete(cb);
	}

	private notify(): void {
		for (const cb of this.updateListeners) cb();
	}

	readonly id: string;
	private readonly deps: SessionDeps;
	readonly images: ImageEntry[];
	readonly params: {
		mArg: string;
		targetDir: string;
		dryRun: boolean;
		onCollision: 'skip' | 'rename' | 'abort';
		batchSize: number;
		pathGlobs: string[];
		standard: string | null;
	};
	readonly checkpoint: Checkpoint | undefined;
	constructor(
		id: string,
		deps: SessionDeps,
		images: ImageEntry[],
		params: {
			mArg: string;
			targetDir: string;
			dryRun: boolean;
			onCollision: 'skip' | 'rename' | 'abort';
			batchSize: number;
			pathGlobs: string[];
			standard: string | null;
		},
		checkpoint?: Checkpoint,
	) {
		this.id = id;
		this.deps = deps;
		this.images = images;
		this.params = params;
		this.checkpoint = checkpoint;
		for (const img of images) this.urlSet.add(img.url);
		this.m = parseM(params.mArg, this.totalForM);
		this.plan();
	}

	private get totalForM(): number {
		const { pathGlobs, standard } = this.params;
		return pathGlobs.length > 0 || standard ? this.images.length : countDistinctFiles(pathGlobs);
	}

	/** 分组 + 切批：单张批次立即自动保留，命中缓存的批次立即恢复裁决。 */
	private plan(): void {
		const groups = groupImages(this.images, this.deps.config.bucketBoundaries);
		for (const [groupIndex, group] of groups.entries()) {
			const batches = createBatches(group.images, this.params.batchSize);
			this.groups.push({
				standardName: group.standardName,
				bucketLabel: group.bucketLabel,
				imageCount: group.images.length,
				batchCount: batches.length,
			});
			for (const batch of batches) {
				const sb: SessionBatch = { groupIndex, batch, status: 'pending' };
				if (batch.images.length < 2) {
					// 单张批次：与 CLI 一致，自动保留（不写缓存）
					sb.status = 'decided';
					sb.source = 'auto-keep';
					sb.result = {
						batch,
						kept: batch.images[0]!,
						losers: [],
						reason: '批次仅 1 张图片，自动保留',
					};
				} else {
					const verdict = this.checkpoint?.lookup(batch.images.map((i) => i.url));
					if (verdict) {
						const restored = restoreFromVerdict(batch, verdict);
						if (restored) {
							sb.status = 'decided';
							sb.source = 'cache';
							sb.result = restored;
						}
					}
				}
				this.batches.push(sb);
			}
		}
	}

	get pendingCount(): number {
		return this.batches.filter((b) => b.status === 'pending').length;
	}

	get losers(): ImageEntry[] {
		return this.batches.flatMap((b) => b.result?.losers ?? []);
	}

	batchAt(index: number): SessionBatch {
		const sb = this.batches[index];
		if (!sb) throw new HttpError(404, `批次不存在: ${index}`);
		return sb;
	}

	private requireSelecting(): void {
		if (this.status !== 'selecting') {
			throw new HttpError(409, `会话已结束选择阶段（${this.status}）`);
		}
	}

	private requireProvider(action: string): LLMProvider {
		const provider = this.deps.provider;
		if (!provider) throw new HttpError(409, `LLM 未配置，${action}不可用`);
		return provider;
	}

	/** LLM 自动选择一个批次（缓存命中则直接返回缓存裁决）。 */
	async autoBatch(index: number): Promise<BatchDTO> {
		this.requireSelecting();
		const provider = this.requireProvider('自动选择');
		const sb = this.batchAt(index);
		if (sb.status === 'decided') throw new HttpError(409, `批次 ${index} 已有裁决`);
		try {
			const { result, reused } = await selectFromBatch(
				sb.batch,
				provider,
				this.deps.config.maxImageDimension,
				this.checkpoint,
			);
			sb.status = 'decided';
			sb.source = reused ? 'cache' : 'llm';
			sb.result = result;
			sb.error = undefined;
			this.notify();
		} catch (e) {
			sb.error = e instanceof Error ? e.message : String(e);
			this.notify();
			throw new HttpError(502, `批次 ${index} LLM 调用失败: ${sb.error}`);
		}
		return this.batchDTO(sb, index);
	}

	/**
	 * 人工选择/改选一个批次的保留者。移动开始前任何状态都可调用（可随时
	 * 调整历史裁决）；调用方在 finalized 状态下应接着触发重赛。
	 * 与 LLM 裁决同构写入 checkpoint 缓存。
	 */
	manualBatch(index: number, keptUrl: string, reason?: string): BatchDTO {
		if (this.status === 'moved') {
			throw new HttpError(409, '移动已完成，不能调整历史裁决');
		}
		if (this.running || this.moving) {
			throw new HttpError(409, '重赛/移动进行中，请稍候');
		}
		const sb = this.batchAt(index);
		const entry = sb.batch.images.find((i) => i.url === keptUrl);
		if (!entry) {
			throw new HttpError(400, `keptUrl 不属于批次 ${index}: ${keptUrl}`);
		}
		const losers = sb.batch.images.filter((i) => i.url !== keptUrl);
		const result: BatchResult = {
			batch: sb.batch,
			kept: entry,
			losers,
			reason: reason?.trim() || '手动选择',
		};
		sb.status = 'decided';
		sb.source = 'manual';
		sb.result = result;
		sb.error = undefined;
		if (this.checkpoint) {
			const urls = sb.batch.images.map((i) => i.url);
			const existing = this.checkpoint.lookup(urls);
			if (!existing || existing.keptUrl !== keptUrl) {
				this.checkpoint.recordOverride({
					urls,
					keptUrl,
					loserUrls: losers.map((l) => l.url),
					reason: result.reason,
					phase: 'batch',
				});
			}
		}
		this.notify();
		return this.batchDTO(sb, index);
	}

	/** 获取 LLM 建议但不写缓存、不改变批次状态（手动挑选界面用）。 */
	async suggest(index: number): Promise<{ keptUrl: string; reason: string; cached: boolean }> {
		this.requireSelecting();
		const provider = this.requireProvider('LLM 建议');
		const sb = this.batchAt(index);
		if (sb.batch.images.length < 2) {
			throw new HttpError(400, `批次 ${index} 仅 1 张图片，无需比较`);
		}
		if (sb.status === 'decided' && sb.result) {
			return { keptUrl: sb.result.kept.url, reason: sb.result.reason, cached: true };
		}
		try {
			const { result } = await selectFromBatch(
				sb.batch,
				provider,
				this.deps.config.maxImageDimension,
				this.checkpoint,
				{ record: false },
			);
			return { keptUrl: result.kept.url, reason: result.reason, cached: false };
		} catch (e) {
			throw new HttpError(502, `批次 ${index} LLM 建议失败: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** 自动跑完所有未决批次。逐批捕获错误，失败不影响后续批次。 */
	async runRemaining(): Promise<void> {
		this.requireSelecting();
		this.requireProvider('自动完成剩余批次');
		if (this.running) throw new HttpError(409, '已有自动任务在执行');
		this.running = true;
		this.notify();
		try {
			for (let i = 0; i < this.batches.length; i++) {
				const sb = this.batches[i]!;
				if (sb.status !== 'pending') continue;
				try {
					await this.autoBatch(i);
				} catch {
					// 错误已记录在 sb.error，继续下一批
				}
			}
		} finally {
			this.running = false;
			this.notify();
		}
	}

	/**
	 * 计算/重算选择结果（「重赛」）：落选者 ≤ m 直接全部移走，否则锦标赛
	 * 淘汰。幂等——可在首次预览前、也可在调整历史裁决后随时调用；锦标赛
	 * 配对按 url 集合缓存，未受影响的配对不会重复调用 LLM。
	 */
	async recomputeSelection(): Promise<void> {
		if (this.status === 'moved') {
			throw new HttpError(409, '移动已完成，不能重赛');
		}
		if (this.running || this.moving) {
			throw new HttpError(409, '重赛/移动进行中，请稍候');
		}
		if (this.pendingCount > 0) {
			throw new HttpError(409, `还有 ${this.pendingCount} 个批次未决定`);
		}
		// 需要锦标赛时先校验 LLM——在任何状态变更之前抛出（不进 try），
		// 避免被误报为「重赛失败」并污染 session.error。
		const provider =
			this.losers.length > this.m
				? this.requireProvider(`锦标赛淘汰（落选者 ${this.losers.length} 张超过目标 ${this.m} 张）`)
				: null;
		this.running = true;
		this.notify();
		try {
			const allLosers = this.losers;
			if (!provider) {
				this.toRemove = allLosers;
				this.tournamentUsed = false;
				this.tournamentRounds = [];
			} else {
				const outcome = await runTournament(
					allLosers,
					this.m,
					provider,
					this.deps.config.maxImageDimension,
					this.checkpoint,
				);
				this.toRemove = outcome.survivors;
				this.tournamentUsed = true;
				this.tournamentRounds = outcome.rounds;
			}
			this.checkpoint?.setToRemoveUrls(this.toRemove.map((i) => i.url));
			this.status = 'finalized';
			this.error = undefined;
		} catch (e) {
			this.error = `重赛失败: ${e instanceof Error ? e.message : String(e)}`;
			throw e;
		} finally {
			this.running = false;
			this.notify();
		}
	}

	/**
	 * 调整历史裁决后在后台自动重赛（立即返回，前端轮询进度）。
	 * 失败信息记录在 session.error，随 DTO 返回。
	 */
	startRecomputeInBackground(): void {
		void this.recomputeSelection().catch(() => undefined);
	}

	/** 移动待移除图片到目标目录（支持 dry-run）。执行期间互斥（moving）。 */
	async move(): Promise<MoveResult[]> {
		if (this.status !== 'finalized') {
			throw new HttpError(409, `当前状态为 ${this.status}，需先完成选择`);
		}
		if (this.running || this.moving) {
			throw new HttpError(409, '重赛/移动进行中，请稍候');
		}
		this.moving = true;
		this.notify();
		try {
			const { results } = await moveImages(this.toRemove, this.params.targetDir, {
				dryRun: this.params.dryRun,
				onCollision: this.params.onCollision,
				...(this.checkpoint !== undefined ? { checkpoint: this.checkpoint } : {}),
			});
			this.moveResults = results;
			this.status = 'moved';
			if (this.checkpoint) {
				if (this.params.dryRun) {
					// 与 CLI 一致：干运行不落 completed，真实执行时仍可复用裁决与移动进度
					this.checkpoint.save();
				} else {
					this.checkpoint.markCompleted();
					clearCheckpoint(this.deps.checkpointPath);
				}
			}
			return results;
		} finally {
			this.moving = false;
			this.notify();
		}
	}

	toDTO(): SessionDTO {
		return {
			id: this.id,
			m: this.m,
			mArg: this.params.mArg,
			targetDir: this.params.targetDir,
			dryRun: this.params.dryRun,
			onCollision: this.params.onCollision,
			totalImages: this.images.length,
			batchSize: this.params.batchSize,
			groups: this.groups,
			batches: this.batches.map((sb, i) => this.batchDTO(sb, i)),
			status: this.status,
			tournamentUsed: this.tournamentUsed,
			tournamentRounds: this.tournamentRounds.map(roundDTO),
			toRemoveImages: this.toRemove.map(toImageDTO),
			moveResults: this.moveResults.map(moveDTO),
			notes: this.notes,
			...(this.error !== undefined ? { error: this.error } : {}),
			running: this.running,
			moving: this.moving,
		};
	}

	private batchDTO(sb: SessionBatch, index: number): BatchDTO {
		const dto: BatchDTO = {
			index,
			groupIndex: sb.groupIndex,
			status: sb.status,
			images: sb.batch.images.map(toImageDTO),
		};
		if (sb.source !== undefined) dto.source = sb.source;
		if (sb.error !== undefined) dto.error = sb.error;
		const r = sb.result;
		if (r) {
			dto.keptUrl = r.kept.url;
			dto.loserUrls = r.losers.map((l) => l.url);
			dto.reason = r.reason;
		}
		return dto;
	}
}

function roundDTO(r: TournamentRound): TournamentRoundDTO {
	return {
		round: r.round,
		pairs: r.pairs.map((p) => ({ kept: p.kept.url, eliminated: p.eliminated.url, reason: p.reason })),
		byes: r.byes.map((b) => b.url),
	};
}

function moveDTO(r: MoveResult): MoveResultDTO {
	const dto: MoveResultDTO = {
		path: r.path,
		status: r.status,
	};
	if (r.targetPath !== undefined) dto.targetPath = r.targetPath;
	if (r.error !== undefined) dto.error = r.error;
	return dto;
}

export function toImageDTO(e: ImageEntry): ImageDTO {
	return {
		url: e.url,
		name: basename(e.url.replaceAll('\\', '/')),
		format: e.imageFormat,
		width: e.width,
		height: e.height,
		sizeBytes: e.sizeBytes,
		maxValue: e.maxValue,
		minValue: e.minValue,
		standardName: e.standardName,
		undecodablePixels: e.undecodablePixels,
	};
}

/**
 * 会话管理器。同一时刻仅允许一个活跃会话（checkpoint 文件与
 * imgval.db 更新是全局资源，且 UI 一次只跑一个清理流程）。
 */
export class SessionManager {
	private sessions = new Map<string, CleanupSession>();

	private readonly deps: SessionDeps;

	constructor(deps: SessionDeps) {
		this.deps = deps;
	}

	get config(): AppConfig {
		return this.deps.config;
	}

	get checkpointEnabled(): boolean {
		return this.deps.checkpointEnabled;
	}

	get llmAvailable(): boolean {
		return this.deps.provider !== null;
	}

	get active(): CleanupSession | undefined {
		for (const s of this.sessions.values()) {
			if (s.status !== 'moved') return s;
		}
		return undefined;
	}

	get(id: string): CleanupSession {
		const s = this.sessions.get(id);
		if (!s) throw new HttpError(404, `会话不存在: ${id}`);
		return s;
	}

	/** 全部会话（含已完成的，用于图片 url 白名单校验）。 */
	all(): IterableIterator<CleanupSession> {
		return this.sessions.values();
	}

	async create(params: CreateSessionBody): Promise<CleanupSession> {
		const active = this.active;
		if (active) {
			throw new HttpError(409, `已有进行中的会话 ${active.id}，请先完成或放弃`);
		}
		const { config, checkpointEnabled } = this.deps;
		const pathGlobs = (params.pathGlobs ?? []).filter((g) => g.length > 0);
		const standard = params.standard?.trim() || null;
		const batchSize = params.batchSize ?? config.batchSize;
		if (!Number.isFinite(batchSize) || batchSize < 2 || batchSize > MAX_BATCH_SIZE) {
			throw new HttpError(400, `批次大小须为 2–${MAX_BATCH_SIZE} 的整数: ${batchSize}`);
		}
		const dryRun = params.dryRun ?? false;
		const onCollision = params.onCollision ?? 'skip';

		const images = getAllImages(pathGlobs, standard ?? undefined);
		if (images.length === 0) {
			throw new HttpError(400, '数据库中没有匹配的图片记录');
		}

		let checkpoint: Checkpoint | undefined;
		let notes: string[] = [];
		if (checkpointEnabled) {
			// Web 端无交互终端，standard 变更等需确认的场景强制复用
			// （与 CLI --force 一致），说明文字返回给前端展示。
			// 无 LLM 时以 manual 裁决身份记录（裁决缓存键含 judge，与真实
			// provider 的缓存互不复用——手动模式下的裁决仅手动模式可见）。
			const judge = this.deps.provider
				? { provider: this.deps.provider.provider, model: this.deps.provider.model }
				: { provider: 'manual', model: 'manual' };
			const resolved = await this.resolveCheckpoint({
				m: parseM(params.mArg, images.length),
				mArg: params.mArg,
				batchSize,
				bucketBoundaries: [...config.bucketBoundaries],
				pathGlobs,
				standardName: standard,
				targetDir: resolvePath(params.targetDir),
				dryRun,
				imageUrls: images.map((i) => i.url),
				...judge,
				maxImageDimension: config.maxImageDimension,
			});
			checkpoint = resolved.checkpoint;
			notes = resolved.notes;
		}

		const session = new CleanupSession(
			randomUUID(),
			this.deps,
			images,
			{ mArg: params.mArg, targetDir: params.targetDir, dryRun, onCollision, batchSize, pathGlobs, standard },
			checkpoint,
		);
		session.notes = notes;
		this.sessions.set(session.id, session);
		return session;
	}

	/** 放弃会话（裁决缓存保留在 checkpoint 文件中，下次运行可复用）。 */
	remove(id: string): void {
		this.sessions.delete(id);
	}

	private resolveCheckpoint(inputs: Parameters<typeof resolveCheckpoint>[1]): Promise<ResolveResult> {
		return resolveCheckpoint(this.deps.checkpointPath, inputs, { force: true });
	}
}
