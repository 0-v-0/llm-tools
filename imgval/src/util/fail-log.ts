import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMMessage, ToolDef, ResponseSchema } from '@llm-image/shared';

export interface FailedRequestDetail {
	url: string;
	image: {
		format: string;
		width: number;
		height: number;
		channels: number | null;
		sizeBytes: number;
		undecodablePixels: number;
		hash: string;
	};
	standardName: string;
	standardVersion: string | null;
	model: string;
	enableTools: boolean;
	systemPrompt: string;
	userMessages: LLMMessage[];
	tools?: ToolDef[];
	responseSchema?: ResponseSchema;
	error: string;
}

/**
 * 记录失败的完整请求到 <failLogDir>/fail-<YYYYMMDDHHmmss>-<hash-prefix>.json。
 * 仅当 failLogDir 提供（非空）时写入。
 */
export function logFailedRequest(failLogDir: string, detail: FailedRequestDetail): string {
	if (!failLogDir) return '';
	mkdirSync(failLogDir, { recursive: true });

	const ts = new Date();
	const pad = (n: number, len = 2) => String(n).padStart(len, '0');
	const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
	const hashPrefix = detail.image.hash.slice(0, 8);
	const file = join(failLogDir, `fail-${stamp}-${hashPrefix}.json`);

	const payload = {
		timestamp: ts.toISOString(),
		error: detail.error,
		image: detail.image,
		url: detail.url,
		standard: {
			name: detail.standardName,
			version: detail.standardVersion,
		},
		model: detail.model,
		toolsEnabled: detail.enableTools,
		request: {
			messages: [
				{ role: 'system', content: detail.systemPrompt },
				...detail.userMessages,
			],
			tools: detail.tools,
			responseSchema: detail.responseSchema,
		},
	};

	appendFileSync(file, JSON.stringify(payload, null, 2) + '\n');
	return file;
}