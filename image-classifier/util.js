import fs from 'fs/promises';
import OpenAI from 'openai';
import path from 'path';

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function completeChat(messages, timeoutSeconds, maxTokens = 4096) {
	const resp = await openai.chat.completions.create(
		{
			model: 'gpt-5.5',
			messages,
			max_tokens: maxTokens,
			temperature: 0.5,
		},
		{ timeout: timeoutSeconds * 1000 },
	);

	const text = resp?.choices?.[0]?.message?.content || resp?.choices?.[0]?.text || '';
	return text.replace(/<think>.*?<\/think>/s, '').trim();
}

export function parseList(value) {
	return value
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

export const extname = (name) => path.extname(name).replace('.', '').toLowerCase();

export async function walk(dir, formats, maxDepth, current = 0, results = []) {
	if (current > maxDepth) return results;
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (e) {
		return results;
	}

	for (const ent of entries) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			await walk(full, formats, maxDepth, current + 1, results);
		} else if (ent.isFile()) {
			const ext = extname(ent.name);
			if (!formats?.length || formats.includes(ext)) results.push(full);
		}
	}
	return results;
}

export async function ensureUnique(dir, nameBase, ext) {
	let candidate = `${nameBase}.${ext}`;
	let i = 1;
	while (true) {
		try {
			await fs.access(path.join(dir, candidate));
			candidate = `${nameBase}-${i}.${ext}`;
			i += 1;
		} catch {
			return candidate;
		}
	}
}

export function info(msg) {
	console.log(`[INFO] ${msg}`);
}
export function error(msg) {
	console.error(`[ERROR] ${msg}`);
}
