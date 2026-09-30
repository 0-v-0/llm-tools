/** 一首歌的输入形态：歌名（可选含「 - 歌手」后缀）。 */
export interface SongRef {
	/** 歌名（已剥离「 - 歌手」后缀） */
	name: string
	/** 歌手（输入行未给出时为空串） */
	artist: string
}

export interface ParsedPlaylist {
	/** 去重后的歌曲（保序，已 trim、滤空行） */
	songs: SongRef[]
	/** 被丢弃的重复歌曲（每次重复出现记一条，格式同输入行） */
	duplicates: string[]
}

/** 「歌名 - 歌手」分隔符：允许 ASCII 连字符两侧带空格，或书名号式的中文间隔号。 */
const ARTIST_SEP = /^(.*?)\s+[-–—]\s+(.+)$/

/**
 * 拆分一行输入为歌名与歌手。
 *
 * 「晴天 - 周杰伦」→ { name: '晴天', artist: '周杰伦' }；只有「晴天」→ artist 为空串。
 * 不做分隔时也允许歌手内部含连字符（取最靠前的分隔符，歌名优先非空）。
 */
export function splitSongLine(line: string): SongRef | null {
	const name = line.trim()
	if (!name)
		return null
	const m = ARTIST_SEP.exec(name)
	if (!m)
		return { name, artist: '' }
	const song = m[1]!.trim()
	const artist = m[2]!.trim()
	// 「- 周杰伦」这类只有歌手没有歌名的输入视为无效
	if (!song || !artist)
		return { name, artist: '' }
	return { name: song, artist }
}

/** 还原为输入行格式「歌名 - 歌手」（无歌手时仅歌名），用于展示、去重与导出。 */
export function formatSongLine(song: SongRef): string {
	return song.artist ? `${song.name} - ${song.artist}` : song.name
}

/** 解析歌单文本：每行一个歌曲，trim、滤空行、拆分歌手、去重（保留首次出现）。 */
export function parsePlaylist(text: string): ParsedPlaylist {
	const seen = new Set<string>()
	const songs: SongRef[] = []
	const duplicates: string[] = []
	for (const line of text.split(/\r?\n/)) {
		const song = splitSongLine(line)
		if (!song)
			continue
		const key = formatSongLine(song)
		if (seen.has(key)) {
			duplicates.push(key)
			continue
		}
		seen.add(key)
		songs.push(song)
	}
	return { songs, duplicates }
}

/** 参与排名的歌单输入（songs 为单歌单内去重后的歌曲）。 */
export interface PlaylistInput {
	ordered: boolean
	songs: SongRef[]
}

/** 有序歌单的相邻歌曲 → 顺序约束链（最终排名须保持其相对顺序）。 */
export function buildOrderConstraints(playlists: readonly PlaylistInput[]): Array<{ before: string; after: string }> {
	const out: Array<{ before: string; after: string }> = []
	for (const p of playlists) {
		if (!p.ordered)
			continue
		const lines = p.songs.map(formatSongLine)
		for (let i = 0; i + 1 < lines.length; i++)
			out.push({ before: lines[i]!, after: lines[i + 1]! })
	}
	return out
}

/** 跨歌单重复出现的歌曲（出现在 ≥2 个歌单；去重保序）。 */
export function crossPlaylistDuplicates(playlists: readonly PlaylistInput[]): string[] {
	const counts = new Map<string, number>()
	for (const p of playlists)
		for (const s of p.songs) {
			const key = formatSongLine(s)
			counts.set(key, (counts.get(key) ?? 0) + 1)
		}
	return [...counts.entries()].filter(([, n]) => n > 1).map(([s]) => s)
}

/**
 * 展开解析 API 模板：{name} 替换为 URL 编码后的歌名，{artist} 替换为歌手。
 *
 * 歌单里没写歌手时，{artist} 连同它所在的查询参数一起删除，而不是留下
 * `artist=` 这个空参数——部分解析 API 会把空串当成有效筛选条件而返回错歌。
 */
export function expandTemplate(tpl: string, song: SongRef): string {
	let url = tpl.replaceAll('{name}', encodeURIComponent(song.name))
	if (song.artist) return url.replaceAll('{artist}', encodeURIComponent(song.artist))
	// 删除 {artist} 所在的整个查询参数（含分隔符），而不是只去掉占位符，
		// 否则会留下 `?artist=` 这种空参数（部分解析 API 会当成有效筛选而返回错歌）。
		// 三步：参数在首位且后面还有参数 → 保留 `?`；不在首位 → 连 `&` 一起删；
		// 唯一参数 → 连 `?` 一起删。
	return url
		.replace(/([?&])([^=&?]*)=\{artist\}&/g, '$1')
		.replace(/&[^=&?]*=\{artist\}(?=&|$)/g, '')
		.replace(/[?&][^=&?]*=\{artist\}/g, '')
		.replace(/\{artist\}/g, '')
}

/**
 * 生成 .m3u8 播放列表（排名序）：#EXTM3U + 每曲 #EXTINF 与解析直链。
 */
export function buildM3u(tpl: string, songs: readonly SongRef[]): string {
	const lines = ['#EXTM3U']
	for (const song of songs) {
		lines.push(`#EXTINF:-1,${formatSongLine(song).replace(/[\r\n]+/g, ' ')}`)
		lines.push(expandTemplate(tpl, song))
	}
	return lines.join('\n') + '\n'
}
