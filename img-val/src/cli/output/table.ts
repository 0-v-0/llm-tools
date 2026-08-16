import type { ValuationRecord } from '../../storage/types.js';
import type { ValuationResult } from '../../valuation/engine.js';
import { decodeUrl } from '../../util/url.js';

export interface MoveResult {
	path: string;
	targetPath?: string;
	maxValue: number;
	status: 'moved' | 'dry-run' | 'skipped' | 'failed';
	error?: string;
}

function formatYuan(value: number): string {
	return `¥${value.toFixed(2)}`;
}

export function renderValuationCard(result: ValuationResult): string {
	const lines: string[] = [];
	const w = 48;

	lines.push('┌' + '─'.repeat(w) + '┐');
	lines.push('│ 图片估值' + ' '.repeat(w - 8) + '│');

	const row = (label: string, value: string) => {
		const content = `${label}: ${value}`;
		const padding = w - content.length;
		lines.push('│ ' + content + ' '.repeat(Math.max(0, padding - 1)) + '│');
	};

	row('URL', decodeUrl(result.image.url));
	row(
		'格式',
		`${result.image.format.toUpperCase()}  尺寸: ${result.image.width}x${result.image.height}`,
	);
	row(
		'标准',
		`${result.standard.name}${result.standard.version ? ` #${result.standard.version.slice(0, 8)}` : ''}`,
	);
	row('模型', result.llm.model);

	lines.push('├' + '─'.repeat(w) + '┤');

	row('最低价值', formatYuan(result.valuation.minValue));
	row('最高价值', formatYuan(result.valuation.maxValue));
	row('不确定性', formatYuan(result.valuation.uncertainty));
	row('置信度', result.valuation.confidence);

	lines.push('├' + '─'.repeat(w) + '┤');

	// Wrap rationale
	const rationaleLines = wrapText(result.valuation.rationale, w - 4);
	row('说明', rationaleLines[0] ?? '-');
	for (let i = 1; i < rationaleLines.length; i++) {
		const line = rationaleLines[i];
		if (line) {
			const padding = w - 1 - line.length;
			lines.push('│   ' + line + ' '.repeat(Math.max(0, padding - 1)) + '│');
		}
	}

	row('备注', result.notes.length > 0 ? result.notes.join('; ') : '-');
	row('时间', result.timestamp);

	lines.push('└' + '─'.repeat(w) + '┘');

	return lines.join('\n');
}

function wrapText(text: string, maxWidth: number): string[] {
	if (!text) return [];
	const lines: string[] = [];
	let current = '';

	for (const char of text) {
		if (current.length >= maxWidth) {
			lines.push(current);
			current = char;
		} else {
			current += char;
		}
	}
	if (current) lines.push(current);

	return lines;
}

export function renderBatchTable(results: ValuationResult[]): string {
	const lines: string[] = [];
	lines.push('');
	lines.push('┌─────────┬──────────────────────┬───────────┬───────────┬───────────┬──────────┐');
	lines.push('│ 序号    │ 图片                 │ 最低价值  │ 最高价值  │ 不确定性  │ 状态     │');
	lines.push('├─────────┼──────────────────────┼───────────┼───────────┼───────────┼──────────┤');

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		if (!r) continue;
		const idx = String(i + 1).padEnd(7);
		const name = decodeUrl(r.image.url).split(/[/\\]/).pop()?.slice(0, 20).padEnd(20) ?? 'unknown'.padEnd(20);
		const min = formatYuan(r.valuation.minValue).padEnd(9);
		const max = formatYuan(r.valuation.maxValue).padEnd(9);
		const unc = formatYuan(r.valuation.uncertainty).padEnd(9);
		const status = (r.image.undecodablePixels === 0 ? 'OK' : '损坏').padEnd(8);
		lines.push(`│ ${idx}│ ${name}│ ${min}│ ${max}│ ${unc}│ ${status}│`);
	}

	lines.push('└─────────┴──────────────────────┴───────────┴───────────┴───────────┴──────────┘');
	lines.push(`共 ${results.length} 张图片`);

	return lines.join('\n');
}

export function renderMoveResults(results: MoveResult[]): string {
	const statusLabel: Record<MoveResult['status'], string> = {
		moved: '已移动',
		'dry-run': '待移动',
		skipped: '跳过',
		failed: '失败',
	};

	const lines: string[] = [];
	if (results.length === 0) {
		return '未找到低于阈值的图片';
	}

	lines.push(`共 ${results.length} 个文件:`);
	lines.push('');
	for (const r of results) {
		lines.push(`  [${statusLabel[r.status]}] ${r.path}`);
		lines.push(`    最高价值: ${formatYuan(r.maxValue)}`);
		if (r.targetPath) lines.push(`    目标: ${r.targetPath}`);
		if (r.error) lines.push(`    原因: ${r.error}`);
		lines.push('');
	}

	return lines.join('\n');
}

export function renderSearchResults(records: ValuationRecord[]): string {
	if (records.length === 0) {
		return '未找到匹配的估值记录';
	}

	const lines: string[] = [];
	lines.push(`找到 ${records.length} 条记录:\n`);

	for (const r of records) {
		lines.push(`  #${r.id}  ${r.imageFormat}  ${r.width}x${r.height}`);
		lines.push(
			`    价值: ¥${r.minValue.toFixed(2)} - ¥${r.maxValue.toFixed(2)} (不确定性: ¥${(r.maxValue - r.minValue).toFixed(2)})`,
		);
		lines.push(`    标准: ${r.standardName}  模型: ${r.llmModel}`);
		lines.push(`    时间: ${r.valuedAt}`);
		lines.push(`    说明: ${r.description}`);
		if (r.notes.length > 0) {
			lines.push(`    备注: ${r.notes.join('; ')}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}
