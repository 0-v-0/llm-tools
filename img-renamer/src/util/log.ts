/** 清理文件名/目录名中的非法字符并规范化空白。 */
export function sanitizeName(name: string): string {
	if (!name) return '';
	const s = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '');
	return s
		.trim()
		.replace(/[\s]+/g, '_')
		.replace(/[. ]+$/g, '');
}

export function info(msg: string): void {
	console.log(`[INFO] ${msg}`);
}

export function error(msg: string): void {
	console.error(`[ERROR] ${msg}`);
}
