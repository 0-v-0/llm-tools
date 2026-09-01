import type { CleanupResult } from '../../selection/engine.js';
import type { MoveResult } from '../../move/mover.js';
import { decodeUrl } from '../../util/url.js';

export function renderCleanupJson(result: CleanupResult): string {
	return JSON.stringify({
		totalImages: result.totalImages,
		groups: result.groups,
		batchCount: result.batchResults.length,
		totalLosers: result.totalLosers,
		tournamentUsed: result.tournamentUsed,
		tournamentRounds: result.tournamentRounds.length,
		toRemove: result.toRemove.map((img) => ({
			url: decodeUrl(img.url),
			standardName: img.standardName,
			imageFormat: img.imageFormat,
			width: img.width,
			height: img.height,
		})),
	}, null, 2);
}

export function renderMoveResultsJson(results: MoveResult[]): string {
	return JSON.stringify(results.map((r) => ({
		path: r.path,
		targetPath: r.targetPath,
		status: r.status,
		error: r.error,
	})), null, 2);
}
