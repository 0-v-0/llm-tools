import { createHash } from 'node:crypto';

export function hashBuffer(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}
