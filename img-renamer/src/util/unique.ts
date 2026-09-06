import { access } from 'node:fs/promises';
import { join } from 'node:path';

/** 生成一个目标目录下不存在的文件名为后缀，避免覆盖。 */
export async function ensureUnique(dir: string, nameBase: string, ext: string): Promise<string> {
	let candidate = `${nameBase}.${ext}`;
	let i = 1;
	while (true) {
		try {
			await access(join(dir, candidate));
			candidate = `${nameBase}-${i}.${ext}`;
			i += 1;
		} catch {
			return candidate;
		}
	}
}
