import { describe, expect, it } from 'vitest'
import { chatCompletionsUrl, parseSongLines } from '../src/extract.ts'

describe('chatCompletionsUrl', () => {
	it('自动补全 chat/completions 路径并去尾部斜杠', () => {
		expect(chatCompletionsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions')
		expect(chatCompletionsUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/chat/completions')
		expect(chatCompletionsUrl('https://x/api/chat/completions')).toBe('https://x/api/chat/completions')
	})
})

describe('parseSongLines', () => {
	it('剥代码围栏、去编号与列表符号、滤空行', () => {
		const content = '```\n1. 晴天\n2. 七里香\n\n- 稻香\n* 夜曲\n```'
		expect(parseSongLines(content)).toEqual(['晴天', '七里香', '稻香', '夜曲'])
	})

	it('保留含数字但无编号分隔符的歌名', () => {
		expect(parseSongLines('24K Magic\n7 rings')).toEqual(['24K Magic', '7 rings'])
	})

	it('纯文本直接逐行解析', () => {
		expect(parseSongLines('晴天\r\n七里香\n\n')).toEqual(['晴天', '七里香'])
	})

	it('无歌名时返回空列表', () => {
		expect(parseSongLines('```\n```')).toEqual([])
	})
})

describe('parseSongLines 省略号（UI 截断）', () => {
	it('剥除行尾省略号，只保留可见文字', () => {
		expect(parseSongLines('寻…\n寻… ')).toEqual(['寻', '寻'])
		expect(parseSongLines('A Very Long Title…')).toEqual(['A Very Long Title'])
	})

	it('剥除三个点形式的省略号', () => {
		expect(parseSongLines('Yesterday...\nHello...')).toEqual(['Yesterday', 'Hello'])
	})

	it('剥除行中间的省略号，保留两侧可见片段', () => {
		expect(parseSongLines('寻…记得')).toEqual(['寻记得'])
	})

	it('省略号 + 歌手被截断：剥除后不留残缺分隔符', () => {
		// 「歌名 - 歌手…」中歌手被截断 → 「歌名 - 歌手」，分隔符合法保留
		expect(parseSongLines('青花瓷 - 周杰…')).toEqual(['青花瓷 - 周杰'])
		// 歌手整体被截掉 → 只剩「歌名 - 」的残缺尾巴，一并剥除
		expect(parseSongLines('青花瓷 - …')).toEqual(['青花瓷'])
		expect(parseSongLines('青花瓷 -…')).toEqual(['青花瓷'])
	})

	it('剥除后为空的行被过滤', () => {
		expect(parseSongLines('…\n...\n晴天')).toEqual(['晴天'])
	})

	it('正常歌名里的单点、双点保留（不误伤：只认 … 与三个点）', () => {
		expect(parseSongLines('Mr. Blue Sky\nI.E.D.\nHey Jude..')).toEqual(['Mr. Blue Sky', 'I.E.D.', 'Hey Jude..'])
	})
})
