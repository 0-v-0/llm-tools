import 'uno.css'
import 'media-rank-web'
import type { MediaRank, RankMode, RankSnapshot } from 'media-rank-web'
import type { MediaSource, MediaSourceParams, OrderConstraint, RankResult } from 'media-rank-web'
import { applyOrderConstraints } from 'media-rank-web'
import { buildM3u, buildOrderConstraints, crossPlaylistDuplicates, expandTemplate, formatSongLine, parsePlaylist, splitSongLine, swapSongLines } from './lib.ts'
import type { PlaylistInput, SongRef } from './lib.ts'
import { extractSongs, imageToDataUrl } from './extract.ts'

const FORM_KEY = 'playlist-rank-web/form'
const SNAPSHOT_KEY = 'playlist-rank-web/snapshot'

interface SavedSnapshot {
	/** 快照所属歌单（去重后的候选 id，即「歌名 - 歌手」整行），恢复前须与当前歌单一致 */
	songs: string[]
	/** 快照所属的 k（找出前 k 名），恢复前须与当前 k 一致 */
	k: number
	snapshot: RankSnapshot
}

/**
 * 歌单输入框的原始内容（撤销快照与表单持久化用）。
 *
 * 与 PlaylistInput（解析后的 songs）刻意分开：前者要还原用户当时看到的输入框，
 * 包括歌单名与写了一半的行，这些在解析后已不存在。
 */
interface PlaylistEntryInput {
	name?: string | undefined
	ordered?: boolean | undefined
	text?: string | undefined
}

interface SavedForm {
	playlists?: PlaylistEntryInput[] | undefined
	list?: string
	k?: number
	tpl?: string
	llmBase?: string
	llmKey?: string
	llmModel?: string
}

const playlistsEl = document.getElementById('playlists')!
const addPlaylistBtn = document.getElementById('add-playlist')!
const tplInput = document.getElementById('tpl') as HTMLInputElement
const kInput = document.getElementById('k') as HTMLInputElement
const verifyInput = document.getElementById('verify') as HTMLInputElement
const startBtn = document.getElementById('start') as HTMLButtonElement
const statusEl = document.getElementById('status')!
const errorEl = document.getElementById('error')!
const warnEl = document.getElementById('warn')!
const actionsEl = document.getElementById('actions')!
const resumeEl = document.getElementById('resume')!
const extractBtn = document.getElementById('extract') as HTMLButtonElement
const imgFile = document.getElementById('img-file') as HTMLInputElement
const llmBase = document.getElementById('llm-base') as HTMLInputElement
const llmKey = document.getElementById('llm-key') as HTMLInputElement
const llmModel = document.getElementById('llm-model') as HTMLInputElement
const mount = document.getElementById('mount')!

/**
 * 解析 API 直连源：模板 URL 即直链（GET 返回音频流）。
 *
 * 直链**优先按当前显示名**展开模板：用户在排名中改了显示名，改的往往正是想听的
 * 那首（歌手写错、歌名写反），此时按旧 id 取链会放错歌——所以 params.name 存在
 * 就用它，只有缺失时才回退按 id 拆「歌名 - 歌手」。因此 `{name}` 得到纯歌名、
 * `{artist}` 得到歌手（两者都没有时该占位符整体消失）。
 * zoom（图片缩略图）对音频无意义，忽略；raw 与 zoom 返回同一音频直链。
 */
class TemplateSource implements MediaSource {
	private readonly tpl: string
	constructor(tpl: string) {
		this.tpl = tpl
	}
	getUrl(id: string, params?: MediaSourceParams): string {
		// 显示名可能只写了歌名（无歌手），splitSongLine 会把整串当歌名
		const song = params?.name ? splitSongLine(params.name) : null
		return expandTemplate(this.tpl, song ?? splitSongLine(id) ?? { name: id, artist: '' })
	}
}

let lastResult: RankResult | null = null
let lastTpl = ''
/** 当前锦标赛的顺序约束反向边（keptId|eliminatedId）：裁决与之相反时提醒 */
let activeForbidden = new Set<string>()

// ---------- 多歌单输入条目 ----------

function addPlaylistEntry(prefill?: PlaylistEntryInput) {
	const root = document.createElement('div')
	root.className = 'w-full flex gap-2 items-stretch'
	root.dataset.role = 'entry'
	root.innerHTML = `
		<div class="flex flex-col gap-1 w-32 shrink-0">
			<input class="input input-bordered input-sm" placeholder="歌单名（可选）" data-role="name">
			<label class="label cursor-pointer gap-1 justify-start text-xs p-0 min-h-0">
				<input type="checkbox" class="toggle toggle-xs" data-role="ordered">
				<span>有序</span>
			</label>
			<button class="btn btn-ghost btn-xs self-start" data-role="swap" type="button"
				title="交换每行「 - 」前后的歌名与歌手（不含「 - 」的行不变）">⇄</button>
		</div>
		<textarea class="textarea textarea-bordered font-mono text-sm grow h-28" data-role="text"
			placeholder="每行一首「歌名 - 歌手」&#10;…或用「从图片提取」/ Ctrl+V 粘贴截图"></textarea>
		<button class="btn btn-ghost btn-xs shrink-0 self-center" data-role="remove" type="button" title="移除此歌单">✕</button>`
	if (prefill?.name) (root.querySelector('[data-role=name]') as HTMLInputElement).value = prefill.name
	if (prefill?.ordered) (root.querySelector('[data-role=ordered]') as HTMLInputElement).checked = true
	if (prefill?.text) (root.querySelector('[data-role=text]') as HTMLTextAreaElement).value = prefill.text
	;((root.querySelector('[data-role=text]') as HTMLTextAreaElement)).addEventListener('input', () => {
		syncStartBtn()
		// 歌单被改动后，旧快照可能与新歌单不再匹配
		syncResumeBar()
		dropExampleUndo()
	})
	;(root.querySelector('[data-role=swap]') as HTMLButtonElement).addEventListener('click', () => {
		const area = root.querySelector('[data-role=text]') as HTMLTextAreaElement
		const before = area.value
		const after = swapSongLines(before)
		if (after === before)
			return
		area.value = after
		// 手工改写等价于一次输入：同步启停按钮与恢复入口，并让示例撤销点失效
		area.dispatchEvent(new Event('input', { bubbles: true }))
	})
	;(root.querySelector('[data-role=remove]') as HTMLButtonElement).addEventListener('click', () => {
		root.remove()
		updateRemoveStates()
		syncStartBtn()
		syncResumeBar()
		dropExampleUndo()
	})
	playlistsEl.append(root)
	updateRemoveStates()
	// 新增歌单也是一种改动（「添加歌单」按钮 / 拖入文件 / 撤销重建都会走到这里）
	dropExampleUndo()
}

/** 至少保留一个歌单输入框。 */
function updateRemoveStates() {
	const removes = [...playlistsEl.querySelectorAll<HTMLButtonElement>('[data-role=remove]')]
	removes.forEach((b) => (b.disabled = removes.length <= 1))
}

/**
 * 读取歌单输入框的**原始**内容（不解析）。
 *
 * 撤销快照必须用这个而非 readPlaylists：后者只给解析后的 songs，会丢掉歌单名、
 * 也丢掉还没写完/写错的行。
 */
function readPlaylistInputs(): PlaylistEntryInput[] {
	return [...playlistsEl.querySelectorAll<HTMLElement>('[data-role=entry]')].map((root) => ({
		name: (root.querySelector('[data-role=name]') as HTMLInputElement).value,
		ordered: (root.querySelector('[data-role=ordered]') as HTMLInputElement).checked,
		text: (root.querySelector('[data-role=text]') as HTMLTextAreaElement).value,
	}))
}

/** 读取全部歌单条目（文本逐单解析去重）。 */
function readPlaylists(): PlaylistInput[] {
	return [...playlistsEl.querySelectorAll<HTMLElement>('[data-role=entry]')].map((root) => ({
		ordered: (root.querySelector('[data-role=ordered]') as HTMLInputElement).checked,
		songs: parsePlaylist((root.querySelector('[data-role=text]') as HTMLTextAreaElement).value).songs,
	}))
}

/** 参与排名的歌曲并集（按「歌名 - 歌手」跨歌单去重，保序）。 */
function currentSongs(): SongRef[] {
	const byLine = new Map<string, SongRef>()
	for (const s of readPlaylists().flatMap((p) => p.songs))
		byLine.set(formatSongLine(s), s)
	return [...byLine.values()]
}

/** 候选的 id 统一为「歌名 - 歌手」整行：去重、顺序约束、展示与导出都以此为准。 */
const songId = (s: SongRef): string => formatSongLine(s)

// ---------- 提示与表单记忆 ----------

function showError(msg: string) {
	errorEl.firstElementChild!.textContent = msg
	errorEl.style.display = ''
}

function hideMessages() {
	errorEl.style.display = 'none'
	warnEl.style.display = 'none'
}

function showWarn(msg: string) {
	warnEl.firstElementChild!.textContent = msg
	warnEl.style.display = ''
}

function saveForm() {
	try {
		localStorage.setItem(FORM_KEY, JSON.stringify({
			playlists: [...playlistsEl.querySelectorAll<HTMLElement>('[data-role=entry]')].map((root) => ({
				name: (root.querySelector('[data-role=name]') as HTMLInputElement).value,
				ordered: (root.querySelector('[data-role=ordered]') as HTMLInputElement).checked,
				text: (root.querySelector('[data-role=text]') as HTMLTextAreaElement).value,
			})),
			k: currentK(),
			tpl: tplInput.value,
			llmBase: llmBase.value,
			llmKey: llmKey.value,
			llmModel: llmModel.value,
		} satisfies SavedForm))
	} catch {
		// localStorage 不可用则忽略
	}
}

function restoreForm() {
	try {
		const saved = JSON.parse(localStorage.getItem(FORM_KEY) ?? 'null') as SavedForm | null
		// 无存档时也要走完下面的补空与 k/tpl 兜底，故不提前返回
		if (saved) {
			if (Array.isArray(saved.playlists) && saved.playlists.length) {
				for (const p of saved.playlists)
					addPlaylistEntry(p)
			} else if (typeof saved.list == 'string') {
				// 旧版单歌单表单迁移
				addPlaylistEntry({ text: saved.list })
			}
			if (typeof saved.k == 'number' && saved.k >= 1)
				kInput.value = String(saved.k)
			if (typeof saved.tpl == 'string') tplInput.value = saved.tpl
			if (typeof saved.llmBase == 'string') llmBase.value = saved.llmBase
			if (typeof saved.llmKey == 'string') llmKey.value = saved.llmKey
			if (typeof saved.llmModel == 'string') llmModel.value = saved.llmModel
		}
	} catch {
		// 忽略
	}
	if (!playlistsEl.children.length)
		addPlaylistEntry()
	syncStartBtn()
}

// ---------- 中断恢复（快照持久化） ----------

/** 候选 id 列表（「歌名 - 歌手」整行），供快照匹配与计数。 */
function currentSongIds(): string[] {
	return currentSongs().map(songId)
}

function loadSnapshot(): SavedSnapshot | null {
	try {
		const s = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? 'null') as SavedSnapshot | null
		const snapOk = !!s?.snapshot
			&& (s.snapshot.kind == 'precise' || s.snapshot.kind == 'topK' || s.snapshot.kind == 'verify')
			&& Array.isArray(s.snapshot.items)
		if (s && Array.isArray(s.songs) && s.songs.length && snapOk && typeof s.k == 'number' && s.k >= 1)
			return s
	} catch {
		// 忽略
	}
	return null
}

function saveSnapshot(songs: readonly string[], k: number, snapshot: RankSnapshot) {
	try {
		localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ songs: [...songs], k, snapshot } satisfies SavedSnapshot))
	} catch {
		// localStorage 不可用则忽略
	}
}

function clearSnapshot() {
	try {
		localStorage.removeItem(SNAPSHOT_KEY)
	} catch {
		// 忽略
	}
}

/** 当前 k 值（输入留空或非法 = 全部 = 歌单并集长度）。 */
function currentK(): number {
	const n = currentSongs().length
	const v = parseInt(kInput.value, 10)
	return Math.max(1, Math.min(v || n, n || 1))
}

/** 歌单并集与 k 值均与当前表单一致时显示「恢复进度」入口。 */
function syncResumeBar() {
	const saved = loadSnapshot()
	const match = !!saved && saved.k == currentK()
		&& JSON.stringify(saved.songs) === JSON.stringify(currentSongIds())
	resumeEl.style.display = match ? '' : 'none'
}

function resume() {
	const saved = loadSnapshot()
	const plan = computePlan()
	if (!saved || !plan) {
		clearSnapshot()
		syncResumeBar()
		return
	}
	hideMessages()
	saveForm()
	lastTpl = plan.tpl
	activeForbidden = forbiddenSet(plan.constraints)
	mountRanker((el) => {
		el.restore(saved.snapshot, new TemplateSource(plan.tpl))
	}, plan.k)
	syncResumeBar()
	setStatus(saved.snapshot.kind == 'precise'
		? `已恢复：精确排序，已比较 ${saved.snapshot.answers.length} 次`
		: saved.snapshot.kind == 'verify'
			? `已恢复：只播重听，已听 ${saved.snapshot.answers.length} 对`
			: `已恢复：前 ${saved.snapshot.target} 名提取，已比较 ${saved.snapshot.answers.length} 次`)
}

// ---------- 排名 ----------

/** 表单校验：模板含 {name} 且歌单非空才可开始。 */
function syncStartBtn() {
	startBtn.disabled = !tplInput.value.includes('{name}') || !currentSongs().length
}

function setStatus(msg: string) {
	statusEl.textContent = msg
}

interface LaunchPlan {
	k: number
	songs: SongRef[]
	tpl: string
	constraints: OrderConstraint[]
	crossDup: string[]
}

/** 读取表单并校验：模板、非空、有序歌单约束无冲突。失败时给出错误提示。 */
function computePlan(): LaunchPlan | null {
	const tpl = tplInput.value.trim()
	if (!tpl.includes('{name}')) {
		showError('解析 API 模板必须包含 {name} 占位符')
		return null
	}
	const playlists = readPlaylists()
	const songs = currentSongs()
	if (!songs.length) {
		showError('歌单为空：每行填写一首「歌名 - 歌手」')
		return null
	}
	const constraints = buildOrderConstraints(playlists)
	// 有序歌单之间的冲突：约束成环则无解，提示检查输入
	const check = applyOrderConstraints(songs.map((s) => ({ id: songId(s) })), constraints)
	if (check.cycle.length) {
		showError(`有序歌单之间存在冲突（${check.cycle.map((m) => m.id).join('、')} 的顺序无法同时满足），请检查输入`)
		return null
	}
	return {
		k: currentK(),
		songs,
		tpl,
		constraints,
		crossDup: crossPlaylistDuplicates(playlists),
	}
}

/** 约束的反向边集合：裁决保留 keptId、淘汰 eliminatedId 时，若存在
	「eliminatedId 须排在 keptId 之前」的约束，则该裁决将被最终重排覆盖。 */
function forbiddenSet(constraints: readonly OrderConstraint[]): Set<string> {
	return new Set(constraints.map((c) => `${c.after}|${c.before}`))
}

/** 创建 <media-rank> 并接好事件（快照持久化 / 约束提醒 / 完成导出），放入 mount。
 *  @param plan_k 快照所属的 k，用于持久化与恢复时的匹配。 */
function mountRanker(init: (el: MediaRank) => void, plan_k: number) {
	lastResult = null
	actionsEl.style.display = 'none'
	mount.innerHTML = ''

	const el = document.createElement('media-rank') as MediaRank
	el.addEventListener('rank-decide', (e) => {
		const d = (e as CustomEvent<{ keptId: string; eliminatedId: string }>).detail
		if (activeForbidden.has(`${d.keptId}|${d.eliminatedId}`))
			showWarn('该裁决与有序歌单中的顺序相反，最终排名将保持有序歌单的相对顺序')
	})
	el.addEventListener('rank-change', (e) => {
		const d = (e as CustomEvent<{ mode: RankMode; round: number; target: number; extractedCount: number; candidatesLeft: number; pendingCount: number; completed: boolean; estimateTotal: number; snapshot: RankSnapshot }>).detail
		saveSnapshot(currentSongIds(), plan_k, d.snapshot)
		setStatus(d.completed ? '排名完成' : d.mode == 'precise'
			? `精确排序进行中：已比较 ${d.round} 次，待裁决 ${d.pendingCount} 对`
			: d.mode == 'verify'
				? `只播重听：已听 ${d.round} / ${d.estimateTotal} 对`
				: `前 ${d.target} 名提取进行中：已比较 ${d.round} 次，已提取 ${d.extractedCount}/${d.target} 名`)
	})
	el.addEventListener('rank-complete', (e) => {
		lastResult = (e as CustomEvent<{ result: RankResult }>).detail.result
		actionsEl.style.display = ''
		setStatus(`排名完成：共 ${lastResult.ranking.length} 首（已保持有序歌单的相对顺序），点击下方按钮导出`)
	})
	init(el)
	mount.append(el)
}

/** 用当前表单开赛（重新点击 = 重新排名）。 */
function launch() {
	const plan = computePlan()
	if (!plan) return
	hideMessages()
	if (plan.crossDup.length)
		showWarn(`以下歌曲在多个歌单中出现，仅保留一份参与排名：${plan.crossDup.join('、')}`)
	saveForm()
	resumeEl.style.display = 'none'
	lastTpl = plan.tpl
	activeForbidden = forbiddenSet(plan.constraints)
	const verifyOnly = verifyInput.checked
	mountRanker((el) => {
		el.constraints = plan.constraints
		// id 与展示名都用「歌名 - 歌手」整行：排序/去重/导出逻辑与无歌手时完全一致
		el.start(plan.songs.map((s) => ({ id: songId(s), kind: 'audio' as const, name: songId(s) })), new TemplateSource(plan.tpl), plan.k, verifyOnly)
	}, plan.k)

	const n = plan.songs.length
	setStatus(verifyOnly
		? `只播重听：按当前顺序相邻试听 ${Math.max(0, n - 1)} 对，不重新排序`
		: plan.k >= n
			? `精确模式：共 ${n} 首，预计约 ${estimatePrecise(n)} 次比较`
			: n < 2 ? '不足 2 首，直接定名次'
			: `共 ${n} 首，找出前 ${plan.k} 名`)
}

/** Ford-Johnson 排序的比较次数估计（Knuth 渐近式）。 */
function estimatePrecise(n: number): number {
	return Math.max(0, Math.round(n * Math.log2(n) - 1.44 * n))
}

// ---------- 追加歌名到歌单（提取 / 拖拽共用） ----------

/** 清洗后的歌曲行追加到最后一个歌单的文本框（不覆盖已有内容）。 */
function appendToLastPlaylist(songs: readonly string[]): boolean {
	if (!songs.length)
		return false
	const areas = [...playlistsEl.querySelectorAll<HTMLTextAreaElement>('[data-role=text]')]
	const target = areas[areas.length - 1]!
	target.value = target.value.trimEnd() ? `${target.value.trimEnd()}\n${songs.join('\n')}` : songs.join('\n')
	target.dispatchEvent(new Event('input', { bubbles: true }))
	saveForm()
	return true
}

// ---------- 从图片提取歌单（多模态 LLM） ----------

/** 提取结果追加到最后一个歌单（不覆盖已有内容，人工修正后开始排名）。 */
async function extractFromImage(file: File) {
	if (!file.type.startsWith('image/')) {
		showError('图片提取失败：请选择图片文件')
		return
	}
	const base = llmBase.value.trim()
	const model = llmModel.value.trim()
	if (!base || !model) {
		showError('从图片提取需要先在「图片提取设置」中填写 API 地址与多模态模型名')
		return
	}
	extractBtn.disabled = true
	setStatus('正在从图片提取歌单…')
	try {
		const dataUrl = await imageToDataUrl(file)
		const songs = await extractSongs({ base, key: llmKey.value.trim(), model }, dataUrl)
		if (!songs.length) {
			setStatus('未能从图片中提取到歌名，可换一张更清晰的截图重试')
			return
		}
		appendToLastPlaylist(songs)
		setStatus(`已从图片提取 ${songs.length} 首歌曲并追加到最后一个歌单，请检查修正后开始排名`)
	} catch (e) {
		showError(`图片提取失败：${(e as Error).message}`)
		setStatus('图片提取失败')
	} finally {
		extractBtn.disabled = false
	}
}

// ---------- 拖拽导入（文本 / .txt 文件 / 截图图片） ----------

/** 拖入文本 → 追加到最后一个歌单；拖入 .txt 文件 → 新建歌单（文件名为歌单名）。 */
function importDroppedText(text: string, asEntryName?: string) {
	// 还原为输入行（保留「歌名 - 歌手」），以便拖进来的内容可再被人工编辑
	const lines = parsePlaylist(text).songs.map(formatSongLine)
	if (!lines.length) {
		setStatus('拖入内容中没有可识别的歌名')
		return
	}
	if (asEntryName != null) {
		addPlaylistEntry({ name: asEntryName, text: lines.join('\n') })
		syncStartBtn()
		syncResumeBar()
		setStatus(`已从拖入文件导入 ${lines.length} 首歌曲为新歌单「${asEntryName}」`)
	} else if (appendToLastPlaylist(lines)) {
		setStatus(`已追加 ${lines.length} 首歌曲到最后一个歌单，请检查修正后开始排名`)
	}
}

function setupDragImport() {
	let depth = 0
	const setHighlight = (on: boolean) => {
		playlistsEl.style.outline = on ? '2px dashed var(--color-primary, #6366f1)' : ''
		playlistsEl.style.outlineOffset = on ? '4px' : ''
	}
	playlistsEl.addEventListener('dragover', (e) => e.preventDefault())
	playlistsEl.addEventListener('dragenter', (e) => {
		e.preventDefault()
		if (++depth == 1) setHighlight(true)
	})
	playlistsEl.addEventListener('dragleave', () => {
		if (--depth == 0) setHighlight(false)
	})
	playlistsEl.addEventListener('drop', (e) => {
		e.preventDefault()
		depth = 0
		setHighlight(false)
		// 落在输入框内的拖放交给浏览器原生行为（文本插入光标处）
		if ((e.target as HTMLElement | null)?.closest('textarea'))
			return
		const dt = e.dataTransfer
		if (!dt) return
		const files = [...dt.files]
		const image = files.find((f) => f.type.startsWith('image/'))
		if (image) {
			void extractFromImage(image)
			return
		}
		const textFile = files.find((f) => f.type.startsWith('text/') || /\.(txt|csv|list|m3u8?)$/i.test(f.name))
		if (textFile) {
			void textFile.text().then((t) => importDroppedText(t, textFile.name.replace(/\.[^.]+$/, '')))
			return
		}
		const text = dt.getData('text/plain') ?? ''
		// 拖拽网页图片/链接时 text 通常是 URL，非歌单内容
		if (text.trim() && !/^https?:\/\//i.test(text.trim()))
			importDroppedText(text)
	})
}

// ---------- 导出 ----------

async function copyRanked() {
	if (!lastResult) return
	const text = lastResult.ranking.map((m) => m.name ?? m.id).join('\n')
	try {
		await navigator.clipboard.writeText(text)
		setStatus(`已复制 ${lastResult.ranking.length} 行排名到剪贴板`)
	} catch (e) {
		showError(`复制失败：${(e as Error).message}`)
	}
}

function downloadM3u() {
	if (!lastResult) return
	// 排名项的 id 即「歌名 - 歌手」整行；解析回 SongRef 才能填 {artist}
	const songs = lastResult.ranking.map((m) => splitSongLine(m.name ?? m.id) ?? { name: m.id, artist: '' })
	const blob = new Blob([buildM3u(lastTpl, songs)], { type: 'audio/x-mpegurl' })
	const a = document.createElement('a')
	a.href = URL.createObjectURL(blob)
	a.download = 'playlist-ranked.m3u8'
	a.click()
	setTimeout(() => URL.revokeObjectURL(a.href), 5000)
	setStatus('已下载 playlist-ranked.m3u8')
}

// ---------- 事件接线 ----------

/** 示例：一个有序歌单 + 一个无序歌单（替换当前全部输入）。
 *  第二首故意不带歌手，演示歌手可省略。 */
const EXAMPLE_PLAYLISTS = [
	{ name: '我的收藏（有序）', ordered: true, text: '晴天 - 周杰伦\n七里香 - 周杰伦\n稻香 - 周杰伦' },
	{ name: '待比较', ordered: false, text: '夜曲\n青花瓷 - 周杰伦\n告白气球 - 周杰伦\n孤勇者' },
]

/** 载入示例前的歌单输入（撤销用）；null = 当前不是示例状态。 */
let exampleUndo: PlaylistEntryInput[] | null = null

/** 按钮在「载入示例」/「撤销」间切换。 */
function syncExampleBtn() {
	const btn = document.getElementById('example')!
	btn.textContent = exampleUndo ? '撤销载入示例' : '载入示例'
	btn.title = exampleUndo ? '恢复到载入示例前的输入' : '填入示例歌单（可撤销）'
	btn.classList.toggle('btn-active', !!exampleUndo)
}

/**
 * 丢弃撤销点：歌单被改动后，「撤销」会把用户的新输入整份丢掉。
 *
 * 宁可按钮回到「载入示例」也不保留撤销点——撤销应只回退「载入示例」这一个
 * 动作，而不是替用户决定丢弃后续编辑。
 */
function dropExampleUndo() {
	if (!exampleUndo) return
	exampleUndo = null
	syncExampleBtn()
}

/** 用快照重建歌单输入（撤销用）。 */
function restoreExampleInput(saved: readonly PlaylistEntryInput[]) {
	playlistsEl.innerHTML = ''
	for (const p of saved)
		addPlaylistEntry({ name: p.name, ordered: p.ordered, text: p.text })
	if (!playlistsEl.children.length)
		addPlaylistEntry()
}

tplInput.addEventListener('input', syncStartBtn)
kInput.addEventListener('input', syncResumeBar)
startBtn.addEventListener('click', launch)
addPlaylistBtn.addEventListener('click', () => addPlaylistEntry())
extractBtn.addEventListener('click', () => imgFile.click())
imgFile.addEventListener('change', () => {
	const file = imgFile.files?.[0]
	imgFile.value = '' // 允许重复选择同一文件
	if (file) void extractFromImage(file)
})
// 截图常用 Ctrl+V 粘贴导入
document.addEventListener('paste', (e) => {
	const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
	if (file) {
		e.preventDefault()
		void extractFromImage(file)
	}
})
document.getElementById('example')!.addEventListener('click', () => {
	// 在「载入示例」与「撤销」间切换：只有当当前内容正是示例时，撤销才有意义
	if (exampleUndo) {
		restoreExampleInput(exampleUndo)
	} else {
		const saved = readPlaylistInputs()
		playlistsEl.innerHTML = ''
		for (const p of EXAMPLE_PLAYLISTS)
			addPlaylistEntry(p)
		// 必须在建完之后再存撤销点：addPlaylistEntry 会丢弃旧的撤销点
		exampleUndo = saved
	}
	syncExampleBtn()
	syncStartBtn()
	syncResumeBar()
})
document.getElementById('copy')!.addEventListener('click', () => void copyRanked())
document.getElementById('download')!.addEventListener('click', downloadM3u)
document.getElementById('resume-btn')!.addEventListener('click', resume)
document.getElementById('discard-btn')!.addEventListener('click', () => {
	clearSnapshot()
	syncResumeBar()
	setStatus('已丢弃上次的排名进度')
})
restoreForm()
setupDragImport()
syncResumeBar()
syncExampleBtn()
