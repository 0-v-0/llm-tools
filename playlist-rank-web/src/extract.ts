/**
 * 从图片提取歌单：多模态 LLM（OpenAI 兼容 chat/completions，浏览器直连），
 * 提取结果为「歌名 - 歌手」列表（UI 文本由提示词排除），交由调用方放进输入框
 * 人工修正。线协议与 @llm-image/shared 的 OpenAI provider 一致（text + image_url 块）。
 */

export const EXTRACTION_PROMPT = `从图片中提取歌单。要求：
- 每行一首，格式为「歌名 - 歌手」。
- 图中能确认歌手时必须写出歌手；确实无法确认歌手时只输出歌名，不要编造，也不要保留空的 " - "。
- 图中文字被界面截断而带省略号（"…" 或 "..."）时，只输出可见的文字，不输出省略号。
- 按图中出现的顺序输出；不要编号，不要任何说明或多余文本。
- 忽略界面 UI 文本：应用/网站名称、标签页、按钮（播放/收藏/下载等）、时长、播放量、进度条、菜单、推荐标语、水印等一切非歌名内容。
- 无法确认是歌名的文本不要输出。`

export interface LlmConfig {
	/** API 地址（OpenAI 兼容，如 https://api.openai.com/v1） */
	base: string
	key: string
	/** 多模态模型名（如 gpt-4o-mini） */
	model: string
}

/** base URL → chat/completions 端点（兼容已带完整路径或以 / 结尾的写法）。 */
export function chatCompletionsUrl(base: string): string {
	const b = base.trim().replace(/\/+$/, '')
	return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`
}

/**
 * 行尾省略号（UI 截断）：`…` 与三个点 `...`。截断只影响可见部分，补全内容
 * 无从得知，故只剥离标记、保留可见文字——宁可短名也不产出带省略号的无法检索串。
 * 省略号出现在行中间（如「寻…记得」）同样剥除，只留可见片段。
 */
const ELLIPSIS = /[…‥]|\.{3,}/g

/** 模型回复 → 歌名列表：剥代码围栏、去列表符号与编号、去省略号、滤空行。 */
export function parseSongLines(content: string): string[] {
	const text = content.replace(/```[a-z]*/gi, '')
	const lines: string[] = []
	for (const raw of text.split(/\r?\n/)) {
		const line = raw
			.trim()
			.replace(/^[-*•]\s+/, '')
			.replace(/^\d+[.、)）]\s+/, '')
			// 省略号只标记「此处被截断」，不含信息；连同其后的多余空白一起去掉
			.replace(ELLIPSIS, '')
			// 剥除后可能留下尾部的「 - 」等残缺分隔符（形如「歌名 - 」）
			.replace(/\s+[-–—]\s*$/, '')
			.trim()
		if (line)
			lines.push(line)
	}
	return lines
}

/** 图片文件 → 缩放到 maxDim 内的 JPEG data URL（控制请求体积）。 */
export async function imageToDataUrl(file: Blob, maxDim = 1600): Promise<string> {
	const bmp = await createImageBitmap(file)
	try {
		const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height))
		const w = Math.max(1, Math.round(bmp.width * scale))
		const h = Math.max(1, Math.round(bmp.height * scale))
		const canvas = document.createElement('canvas')
		canvas.width = w
		canvas.height = h
		canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
		return canvas.toDataURL('image/jpeg', 0.9)
	} finally {
		bmp.close()
	}
}

/** 调多模态 LLM 提取歌单，返回歌名列表（可能为空）。 */
export async function extractSongs(cfg: LlmConfig, imageDataUrl: string): Promise<string[]> {
	const res = await fetch(chatCompletionsUrl(cfg.base), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}),
		},
		body: JSON.stringify({
			model: cfg.model,
			messages: [{
				role: 'user',
				content: [
					{ type: 'text', text: EXTRACTION_PROMPT },
					{ type: 'image_url', image_url: { url: imageDataUrl } },
				],
			}],
		}),
	})
	if (!res.ok) {
		const detail = await res.text().catch(() => '')
		throw new Error(`LLM API ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`)
	}
	const data = await res.json()
	const content: string | undefined = data?.choices?.[0]?.message?.content
	if (!content)
		throw new Error('LLM API 返回为空')
	return parseSongLines(content)
}
