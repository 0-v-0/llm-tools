import { promises as fs, createWriteStream } from 'node:fs';
import { extname } from 'node:path';
import OpenAI from 'openai';

const client = new OpenAI({
	apiKey: 'API Key',
	baseURL: 'http://localhost:5001/v1',
});

const model = '<model>';

async function translate(input) {
	const prompt = `你现在是一个标签翻译器，将以下danbooru中的标签翻译成中文，用=分隔。\n${input}`;
	const response = await client.completions.create({
		prompt,
		model,
		max_tokens: 35,
		temperature: 0.2,
		top_p: 0.65,
		stop: '\n',
	});
	const text = response.choices[0].text;
	const i = text.indexOf('\n');
	return i === -1 ? text : text.slice(0, i);
}

const maxLineCount = 60;

async function main() {
	const input = process.argv[2];
	if (!input) {
		console.log('Usage: node index.js <input>');
		process.exit(1);
	}
	const start = 0;
	const ext = extname(input);
	const output = createWriteStream(input.replace(ext, '-tr' + ext), { encoding: 'utf-8' });
	const content = await fs.readFile(input, 'utf-8');
	const lines = content.split('\n');
	output.write(lines.slice(0, start).join('\n') + '\n');

	for (let i = start; i < lines.length; i++) {
		const p = lines[i].indexOf('=');
		if (p !== -1) lines[i] = lines[i].substring(0, p);
		const data = lines.slice(Math.max(0, i - maxLineCount), i + 1).join('\n') + '=';
		const res = await translate(data);
		lines[i] += '=' + res + '\n';
		output.write(lines[i]);
		if (i % 100 === 0) {
			console.log(`Translated ${i} lines`);
		}
	}
	output.end();
}

main();
