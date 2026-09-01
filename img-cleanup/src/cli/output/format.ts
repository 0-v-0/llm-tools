export const FORMAT_FLAGS = '--format <text|json>';
export const FORMAT_DESCRIPTION = '输出格式：text（默认）| json';

export function isJsonFormat(format?: string): boolean {
	return format === 'json';
}
