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
