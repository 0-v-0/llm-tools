import type { CleanupResult } from '../../selection/engine.js';
import type { MoveResult } from '../../move/mover.js';
import { decodeUrl } from '../../util/url.js';

export function renderCleanupSummary(result: CleanupResult): string {
	const lines: string[] = [];
	lines.push('');
	lines.push('┌──────────────────────────────────────────┐');
	lines.push('│          图片清理结果概览               │');
	lines.push('├──────────────────────────────────────────┤');
	lines.push(`│ 数据库总图片: ${String(result.totalImages).padEnd(24)}│`);
	lines.push(`│ 分组数量:     ${String(result.groups.length).padEnd(24)}│`);
	lines.push(`│ 批次总数:     ${String(result.batchResults.length).padEnd(24)}│`);
	lines.push(`│ 落选者总数:   ${String(result.totalLosers).padEnd(24)}│`);
	lines.push(`│ 锦标赛:       ${(result.tournamentUsed ? '是' : '否').padEnd(24)}│`);
	if (result.tournamentUsed) {
		lines.push(`│ 锦标赛轮数:   ${String(result.tournamentRounds.length).padEnd(24)}│`);
	}
	lines.push(`│ 最终移走:     ${String(result.toRemove.length).padEnd(24)}│`);
	lines.push('└──────────────────────────────────────────┘');

	// Groups
	if (result.groups.length > 0) {
		lines.push('\n分组明细:');
		for (const g of result.groups) {
			lines.push(`  [${g.standardName} / ${g.bucketLabel}] ${g.imageCount} 张 → ${g.batchCount} 批次`);
		}
	}

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
		return '无需移动的图片';
	}

	lines.push(`共 ${results.length} 个文件:`);
	lines.push('');
	for (const r of results) {
		lines.push(`  [${statusLabel[r.status]}] ${r.path}`);
		if (r.targetPath) lines.push(`    目标: ${r.targetPath}`);
		if (r.error) lines.push(`    原因: ${r.error}`);
		lines.push('');
	}

	const moved = results.filter((r) => r.status === 'moved').length;
	lines.push(`成功移动 ${moved} 个文件`);
	return lines.join('\n');
}

export function renderToRemoveList(result: CleanupResult): string {
	const lines: string[] = [];
	lines.push('\n待移走图片列表:');
	for (let i = 0; i < result.toRemove.length; i++) {
		const img = result.toRemove[i]!;
		const filename = decodeUrl(img.url).split(/[/\\]/).pop() ?? img.url;
		lines.push(`  ${i + 1}. ${filename} (${img.standardName})`);
	}
	return lines.join('\n');
}
