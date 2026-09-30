import { describe, expect, it } from 'vitest'
import {
	buildM3u,
	buildOrderConstraints,
	crossPlaylistDuplicates,
	expandTemplate,
	formatSongLine,
	parsePlaylist,
	splitSongLine,
} from '../src/lib.ts'
import type { PlaylistInput } from '../src/lib.ts'

/** 断言歌曲数组等于 [['歌名','歌手'], …] 的紧凑写法。 */
const songsOf = (songs: { name: string; artist: string }[]) => songs.map((s) => [s.name, s.artist])

describe('splitSongLine', () => {
	it('「歌名 - 歌手」拆成两段', () => {
		expect(splitSongLine('晴天 - 周杰伦')).toEqual({ name: '晴天', artist: '周杰伦' })
		expect(songsOf([splitSongLine('晴天 - 周杰伦')!])).toEqual([['晴天', '周杰伦']])
	})

	it('无歌手时 artist 为空串', () => {
		expect(splitSongLine('晴天')).toEqual({ name: '晴天', artist: '' })
	})

	it('容忍分隔符两侧多空格、以及 – — 分隔符', () => {
		expect(splitSongLine('晴天  -  周杰伦')).toEqual({ name: '晴天', artist: '周杰伦' })
		expect(splitSongLine('晴天 – 周杰伦')).toEqual({ name: '晴天', artist: '周杰伦' })
		expect(splitSongLine('晴天 — 周杰伦')).toEqual({ name: '晴天', artist: '周杰伦' })
	})

	it('分隔符必须两侧带空格，避免拆坏带连字符的歌名', () => {
		expect(splitSongLine('Spider-Man')).toEqual({ name: 'Spider-Man', artist: '' })
		expect(splitSongLine('晴天-周杰伦')).toEqual({ name: '晴天-周杰伦', artist: '' })
	})

	it('歌手含连字符时取最靠前的分隔符（歌名优先）', () => {
		expect(splitSongLine('Casey Jones - Jamie-Lynn')).toEqual({ name: 'Casey Jones', artist: 'Jamie-Lynn' })
	})

	it('空行返回 null', () => {
		expect(splitSongLine('   ')).toBeNull()
	})

	it('缺少歌名或歌手的残缺写法整体当作歌名', () => {
		expect(splitSongLine('- 周杰伦')).toEqual({ name: '- 周杰伦', artist: '' })
		expect(splitSongLine('晴天 -')).toEqual({ name: '晴天 -', artist: '' })
	})
})

describe('formatSongLine', () => {
	it('有歌手拼成「歌名 - 歌手」，否则仅歌名', () => {
		expect(formatSongLine({ name: '晴天', artist: '周杰伦' })).toBe('晴天 - 周杰伦')
		expect(formatSongLine({ name: '晴天', artist: '' })).toBe('晴天')
	})

	it('与 splitSongLine 互为逆运算', () => {
		for (const line of ['晴天 - 周杰伦', '晴天', 'Casey Jones - Jamie-Lynn']) {
			expect(formatSongLine(splitSongLine(line)!)).toBe(line)
		}
	})
})

describe('parsePlaylist', () => {
	it('逐行解析：trim、滤空行、保序，并拆出歌手', () => {
		const { songs, duplicates } = parsePlaylist('  晴天 - 周杰伦 \n\n七里香\r\n\r\n 稻香 - 周杰伦 ')
		expect(songsOf(songs)).toEqual([['晴天', '周杰伦'], ['七里香', ''], ['稻香', '周杰伦']])
		expect(duplicates).toEqual([])
	})

	it('按整行去重（保留首次出现）并记录', () => {
		const { songs, duplicates } = parsePlaylist('晴天 - 周杰伦\nB\n晴天 - 周杰伦\n 晴天 - 周杰伦 \nB')
		expect(songsOf(songs)).toEqual([['晴天', '周杰伦'], ['B', '']])
		expect(duplicates).toEqual(['晴天 - 周杰伦', '晴天 - 周杰伦', 'B'])
	})

	it('同名不同歌手视为两首不同的歌', () => {
		const { songs, duplicates } = parsePlaylist('晴天 - 周杰伦\n晴天 - 林俊杰')
		expect(songsOf(songs)).toEqual([['晴天', '周杰伦'], ['晴天', '林俊杰']])
		expect(duplicates).toEqual([])
	})

	it('空文本返回空歌单', () => {
		const { songs, duplicates } = parsePlaylist('\n \n\r\n')
		expect(songs).toEqual([])
		expect(duplicates).toEqual([])
	})
})

describe('expandTemplate', () => {
	it('{name} 替换为 URL 编码后的歌名（不含歌手）', () => {
		expect(expandTemplate('http://x/api?n={name}', { name: '晴天', artist: '周杰伦' }))
			.toBe('http://x/api?n=' + encodeURIComponent('晴天'))
		expect(expandTemplate('http://x/{name}/play?title={name}', { name: 'a b&c', artist: '' }))
			.toBe('http://x/a%20b%26c/play?title=a%20b%26c')
	})

	it('{artist} 替换为 URL 编码后的歌手', () => {
		expect(expandTemplate('http://x/api?n={name}&a={artist}', { name: '晴天', artist: '周杰伦' }))
			.toBe('http://x/api?n=' + encodeURIComponent('晴天') + '&a=' + encodeURIComponent('周杰伦'))
		expect(expandTemplate('http://x/a={artist}', { name: 'x', artist: 'A&B' }))
			.toBe('http://x/a=' + encodeURIComponent('A&B'))
	})

	it('无歌手时整个 artist 参数被删除，不留空参数', () => {
		// `?artist={artist}&n={name}` → `?n=晴天`
		expect(expandTemplate('http://x/api?artist={artist}&n={name}', { name: '晴天', artist: '' }))
			.toBe('http://x/api?n=' + encodeURIComponent('晴天'))
		// `?n={name}&artist={artist}`（在末尾）→ `?n=晴天`
		expect(expandTemplate('http://x/api?n={name}&artist={artist}', { name: '晴天', artist: '' }))
			.toBe('http://x/api?n=' + encodeURIComponent('晴天'))
		// 只有 artist 参数 → 只剩 origin
		expect(expandTemplate('http://x/api?a={artist}', { name: '晴天', artist: '' })).toBe('http://x/api')
		// 路径中的占位（非查询参数）只去掉占位本身
		expect(expandTemplate('http://x/{artist}/{name}', { name: '晴天', artist: '' }))
			.toBe('http://x//' + encodeURIComponent('晴天'))
	})

	it('有歌手时参数正常保留', () => {
		expect(expandTemplate('http://x/api?artist={artist}&n={name}', { name: '晴天', artist: '周杰伦' }))
			.toBe('http://x/api?artist=' + encodeURIComponent('周杰伦') + '&n=' + encodeURIComponent('晴天'))
	})

	it('无占位符时原样返回', () => {
		expect(expandTemplate('http://x/api', { name: 'A', artist: '' })).toBe('http://x/api')
	})
})

describe('buildOrderConstraints', () => {
	const p = (ordered: boolean, songs: string[]): PlaylistInput => ({
		ordered,
		songs: songs.map((line) => splitSongLine(line)!),
	})

	it('有序歌单的相邻歌曲构成约束链；无序歌单不产生约束', () => {
		const ps = [p(true, ['晴天 - 周杰伦', '七里香 - 周杰伦', '稻香 - 周杰伦']), p(false, ['夜曲', '青花瓷'])]
		expect(buildOrderConstraints(ps)).toEqual([
			{ before: '晴天 - 周杰伦', after: '七里香 - 周杰伦' },
			{ before: '七里香 - 周杰伦', after: '稻香 - 周杰伦' },
		])
	})

	it('单歌单/空歌单不产生约束', () => {
		expect(buildOrderConstraints([p(true, ['a'])])).toEqual([])
		expect(buildOrderConstraints([p(true, [])])).toEqual([])
	})
})

describe('crossPlaylistDuplicates', () => {
	const p = (songs: string[]): PlaylistInput => ({ ordered: false, songs: songs.map((l) => splitSongLine(l)!) })

	it('出现在多个歌单的歌曲被报告（格式为输入行）', () => {
		const ps = [p(['晴天 - 周杰伦', '七里香']), p(['七里香', '稻香']), p(['晴天 - 周杰伦'])]
		expect(crossPlaylistDuplicates(ps)).toEqual(['晴天 - 周杰伦', '七里香'])
	})

	it('同名不同歌手不算重复', () => {
		expect(crossPlaylistDuplicates([p(['晴天 - 周杰伦']), p(['晴天 - 林俊杰'])])).toEqual([])
	})

	it('无跨歌单重复时返回空', () => {
		expect(crossPlaylistDuplicates([p(['a', 'b'])])).toEqual([])
	})
})

describe('buildM3u', () => {
	it('生成 #EXTM3U 头 + 每曲 EXTINF 与直链，排名序', () => {
		const m3u = buildM3u('http://x/api?n={name}', [
			{ name: 'B', artist: '' },
			{ name: 'A', artist: 'X' },
		])
		expect(m3u.split('\n')).toEqual([
			'#EXTM3U',
			'#EXTINF:-1,B',
			'http://x/api?n=B',
			'#EXTINF:-1,A - X',
			'http://x/api?n=A',
			'',
		])
	})

	it('EXTINF 标题为「歌名 - 歌手」并把换行替换为空格', () => {
		const m3u = buildM3u('http://x?n={name}', [{ name: 'a\r\nb', artist: '' }])
		expect(m3u).toContain('#EXTINF:-1,a b')
	})

	it('直链同时填充 {name} 与 {artist}', () => {
		const m3u = buildM3u('http://x?n={name}&a={artist}', [{ name: '晴天', artist: '周杰伦' }])
		expect(m3u).toContain('http://x?n=' + encodeURIComponent('晴天') + '&a=' + encodeURIComponent('周杰伦'))
	})
})