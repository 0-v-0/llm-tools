import 'uno.css'
import '../element.ts'
import type { MediaRank } from '../element.ts'
import type { MediaItem, MediaSource, MediaSourceParams } from '../types.ts'

// ---------- 运行时合成示例媒体（无二进制资产） ----------

const hash = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)
const rnd = (n: number): number => Math.abs(Math.sin(n * 12.9898) * 43758.5453) % 1

const imageCache = new Map<string, string>()

/** canvas 合成带 id 标识的图案（zoom 参数映射生成尺寸，raw 为 1024 原图）。 */
function imageUrl(id: string, size: number): string {
	const key = `${id}@${size}`
	const hit = imageCache.get(key)
	if (hit) return hit
	const clamped = Math.max(64, Math.min(1024, size))
	const canvas = document.createElement('canvas')
	canvas.width = canvas.height = clamped
	const ctx = canvas.getContext('2d')!
	const seed = hash(id)
	const hue = seed % 360
	const g = ctx.createLinearGradient(0, 0, clamped, clamped)
	g.addColorStop(0, `hsl(${hue} 70% 55%)`)
	g.addColorStop(1, `hsl(${(hue + 90) % 360} 70% 35%)`)
	ctx.fillStyle = g
	ctx.fillRect(0, 0, clamped, clamped)
	for (let i = 0; i < 6; i++) {
		ctx.beginPath()
		ctx.arc(rnd(seed + i) * clamped, rnd(seed + i * 3) * clamped, clamped * (0.05 + rnd(seed + i * 7) * 0.12), 0, Math.PI * 2)
		ctx.fillStyle = `hsla(${(hue + i * 50) % 360} 80% 70% / .45)`
		ctx.fill()
	}
	ctx.fillStyle = 'rgba(255,255,255,.92)'
	ctx.font = `bold ${clamped / 9}px sans-serif`
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.fillText(id, clamped / 2, clamped / 2)
	const url = canvas.toDataURL('image/png')
	imageCache.set(key, url)
	return url
}

const wavCache = new Map<string, string>()

/** 合成 1.5s 和弦音 WAV（不同 id 基音不同），blob url 直链。 */
function wavUrl(id: string): string {
	const hit = wavCache.get(id)
	if (hit) return hit
	const seed = hash(id)
	const sampleRate = 11025
	const duration = 1.5
	const n = Math.round(sampleRate * duration)
	const buf = new ArrayBuffer(44 + n * 2)
	const view = new DataView(buf)
	const writeStr = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
	}
	writeStr(0, 'RIFF')
	view.setUint32(4, 36 + n * 2, true)
	writeStr(8, 'WAVE')
	writeStr(12, 'fmt ')
	view.setUint32(16, 16, true)
	view.setUint16(20, 1, true) // PCM
	view.setUint16(22, 1, true) // mono
	view.setUint32(24, sampleRate, true)
	view.setUint32(28, sampleRate * 2, true)
	view.setUint16(32, 2, true)
	view.setUint16(34, 16, true)
	writeStr(36, 'data')
	view.setUint32(40, n * 2, true)
	const base = 220 * Math.pow(2, (Math.abs(seed) % 12) / 12)
	for (let i = 0; i < n; i++) {
		const t = i / sampleRate
		const env = Math.min(1, t * 8) * Math.exp(-t * 1.8)
		const s = (Math.sin(2 * Math.PI * base * t) * 0.6
			+ Math.sin(2 * Math.PI * base * 2 * t) * 0.25
			+ Math.sin(2 * Math.PI * base * 3 * t) * 0.12) * env * 0.5
		view.setInt16(44 + i * 2, s * 32767, true)
	}
	const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
	wavCache.set(id, url)
	return url
}

const videoUrls = new Map<string, string>()

/** canvas 动画 + MediaRecorder 合成 1.6s WebM（浏览器不支持时返回空串）。 */
async function makeVideo(id: string): Promise<string> {
	if (typeof MediaRecorder == 'undefined' || !HTMLCanvasElement.prototype.captureStream) return ''
	const canvas = document.createElement('canvas')
	canvas.width = 640
	canvas.height = 360
	const ctx = canvas.getContext('2d')!
	const stream = canvas.captureStream(24)
	const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'
	const rec = new MediaRecorder(stream, { mimeType: mime })
	const chunks: Blob[] = []
	rec.ondataavailable = (e) => {
		if (e.data.size) chunks.push(e.data)
	}
	const done = new Promise<void>((res) => (rec.onstop = () => res()))
	rec.start()
	const hue = hash(id) % 360
	const t0 = performance.now()
	await new Promise<void>((res) => {
		// 后台标签页会完全暂停 rAF，用 setInterval 保证时间推进
		const timer = setInterval(() => {
			const t = (performance.now() - t0) / 1000
			ctx.fillStyle = `hsl(${(hue + t * 120) % 360} 65% 45%)`
			ctx.fillRect(0, 0, 640, 360)
			for (let i = 0; i < 5; i++) {
				ctx.fillStyle = `hsl(${(hue + i * 40 + t * 200) % 360} 70% 60%)`
				ctx.fillRect(((t * 120 + i * 140) % 780) - 140, 40 + i * 56, 120, 36)
			}
			ctx.fillStyle = 'rgba(255,255,255,.92)'
			ctx.font = 'bold 64px sans-serif'
			ctx.textAlign = 'center'
			ctx.textBaseline = 'middle'
			ctx.fillText(id, 320, 180)
			if (t >= 1.6) {
				clearInterval(timer)
				res()
			}
		}, 33)
	})
	rec.stop()
	await done
	const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }))
	videoUrls.set(id, url)
	return url
}

// ---------- demo MediaSource：id → 直链（zoom/raw 参数解释见上） ----------

class DemoSource implements MediaSource {
	getUrl(id: string, params?: MediaSourceParams): string {
		const kind = id.split('-')[0]
		if (params?.raw) {
			if (kind == 'video') return videoUrls.get(id) ?? ''
			if (kind == 'audio') return wavUrl(id)
			return imageUrl(id, 1024)
		}
		const zoom = typeof params?.zoom == 'number' && params.zoom > 0 ? params.zoom : 512
		return imageUrl(id, zoom)
	}
}

const items: MediaItem[] = [
	{ id: 'img-0', name: '山景 · 清晨.jpg', kind: 'image', meta: '3840×2160 · 4.2 MB' },
	{ id: 'img-1', name: '海岸 · 黄昏.jpg', kind: 'image', meta: '2560×1440 · 2.8 MB' },
	{ id: 'img-2', name: '森林 · 雾.jpg', kind: 'image', meta: '1920×1080 · 1.6 MB' },
	{ id: 'img-3', name: '沙漠 · 正午.jpg', kind: 'image', meta: '4096×2160 · 6.1 MB' },
	{ id: 'img-4', name: '湖泊 · 夜.jpg', kind: 'image', meta: '2560×1440 · 3.0 MB' },
	{ id: 'img-5', name: '城市 · 雨.jpg', kind: 'image', meta: '1920×1080 · 1.9 MB' },
	{ id: 'audio-0', name: '钢琴小品.flac', kind: 'audio', meta: '03:21 · 28.5 MB' },
	{ id: 'audio-1', name: '弦乐四重奏.wav', kind: 'audio', meta: '05:02 · 51.3 MB' },
	{ id: 'audio-2', name: '环境音.mp3', kind: 'audio', meta: '02:47 · 6.4 MB' },
	{ id: 'video-0', name: '延时摄影.mp4', kind: 'video', meta: '00:15 · 1080p' },
	{ id: 'video-1', name: '航拍.mp4', kind: 'video', meta: '00:42 · 4K' },
	{ id: 'video-2', name: '手部特写.mov', kind: 'video', meta: '00:08 · 1080p' },
]

// ---------- 页面接线 ----------

const statusEl = document.getElementById('status')!
const mount = document.getElementById('mount')!
const targetInput = document.getElementById('target') as HTMLInputElement
const verifyInput = document.getElementById('verify-only') as HTMLInputElement

function launch() {
	const target = Math.max(1, parseInt(targetInput.value, 10) || 2)
	const verifyOnly = verifyInput.checked
	mount.innerHTML = ''
	const el = document.createElement('media-rank') as MediaRank
	el.addEventListener('rank-change', (e) => {
		const d = (e as CustomEvent).detail as { mode: string; round: number; target: number; extractedCount: number; completed: boolean; estimateTotal: number }
		statusEl.textContent = d.completed ? '完成' : d.mode == 'precise'
			? `精确排序：已比较 ${d.round} 次`
			: d.mode == 'verify'
				? `顺序校验：已听 ${d.round} / ${d.estimateTotal} 对`
				: `前 ${d.target} 名提取：已比较 ${d.round} 次，已提取 ${d.extractedCount}/${d.target} 名`
	})
	el.addEventListener('rank-complete', () => {
		statusEl.textContent = '完成（见下方播放列表）'
	})
	el.start(items, new DemoSource(), target, verifyOnly)
	mount.append(el)
}

async function init() {
	try {
		statusEl.textContent = '正在合成示例视频…'
		const videos = await Promise.all(items.filter((i) => i.kind == 'video').map((i) => makeVideo(i.id)))
		if (videos.some((v) => !v))
			statusEl.textContent = '⚠ 浏览器不支持 MediaRecorder，视频项无法播放（其余功能不受影响）'
		launch()
		document.getElementById('start')!.addEventListener('click', launch)
	} catch (e) {
		statusEl.textContent = `⚠ 示例视频合成失败（${(e as Error).message}），视频项无法播放`
		launch()
		document.getElementById('start')!.addEventListener('click', launch)
	}
}

void init()
