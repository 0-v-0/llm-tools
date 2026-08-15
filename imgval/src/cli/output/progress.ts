export interface ProgressBar {
	tick(): void;
	complete(): void;
}

/** 简单的单行进度条，使用 `\r` 原地刷新终端。 */
export function createProgressBar(total: number, width = 30): ProgressBar {
	let completed = 0;
	let active = true;

	function render() {
		const pct = completed / total;
		const filled = Math.round(Math.min(1, Math.max(0, pct)) * width);
		const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
		process.stdout.write(`\r[${bar}] ${(pct * 100).toFixed(1)}% (${completed}/${total})`);
	}

	return {
		tick() {
			completed++;
			if (active) render();
		},
		complete() {
			active = false;
			process.stdout.write('\r' + ' '.repeat(width + 20) + '\r');
		},
	};
}