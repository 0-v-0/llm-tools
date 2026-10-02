export type MediaKind = 'image' | 'audio' | 'video'

export interface MediaItem {
	/** 传给 MediaSource 的标识（数据库 id、路径或完整 url） */
	id: string
	/** 决定渲染方式（<img>/<audio>/<video>），缺省按 'image' */
	kind?: MediaKind
	/** 展示名，缺省取 id 的 basename */
	name?: string
	/** 可选徽标元数据（尺寸/时长/大小等） */
	meta?: string
}

export interface MediaSourceParams {
	/** 缩略/预览尺寸请求（px），由 MediaSource 自行解释 */
	zoom?: number
	/** 原始文件流（不做缩放/转码） */
	raw?: boolean
	/**
	 * 该项当前的**显示名**（`MediaItem.name`；缺省时为 id 的 basename）。
	 *
	 * id 才是稳定的标识，但有些源的直链是**按名字**解析的（如 playlist-rank-web
	 * 用「歌名 - 歌手」展开 URL 模板）。传入 name 让这类源跟随改名，不提供的源
	 * 忽略它、行为与从前一致。
	 */
	name?: string
}

/**
 * 媒体文件源：id/url → 直链。返回值可直接用作 img/audio/video 的 src，
 * 可以是同源代理端点、对象存储 url 或 data/blob url。
 */
export interface MediaSource {
	getUrl(id: string, params?: MediaSourceParams): string
}

export interface PairRecord {
	kept: MediaItem
	eliminated: MediaItem
}

export interface TournamentRound {
	round: number
	pairs: PairRecord[]
	byes: MediaItem[]
}

export interface RankResult {
	/** 最终保留集（名次 1..k，顺序同收敛时的候选序） */
	survivors: MediaItem[]
	/** 完整排名：survivors 在前，其后按淘汰轮次从晚到早（越晚淘汰名次越高） */
	ranking: MediaItem[]
	/** 逐轮对局记录 */
	rounds: TournamentRound[]
}
