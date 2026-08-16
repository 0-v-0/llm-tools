import { AppError } from '@llm-image/shared';
import { Command } from 'commander';
import type { SearchParams, ImageFormat } from '../storage/types.js';
import { loadEnv } from '../config/env.js';
import { bootstrap } from '../config/paths.js';
import { search, searchByText } from '../storage/repository.search.js';
import { renderRecordsJson } from './output/json.js';
import { renderSearchResults } from './output/table.js';
import { FORMAT_FLAGS, FORMAT_DESCRIPTION, isJsonFormat } from './output/format.js';

interface SearchOptions {
	filter?: string[];
	limit?: string;
	format?: string;
}

function parseQuery(query: string): { params: SearchParams; freeText: string } {
	const params: SearchParams = {};
	const tokens: string[] = [];

	const parts = query.split(/\s+/);
	for (const part of parts) {
		const match = part.match(/^(\w+):(.+)$/);
		if (match && match[1] && match[2]) {
			const key = match[1];
			const value = match[2];
			switch (key) {
				case 'min':
					params.minValue = parseFloat(value);
					break;
				case 'max':
					params.maxValue = parseFloat(value);
					break;
				case 'standard':
					params.standardName = value;
					break;
				case 'from':
					params.dateFrom = value;
					break;
				case 'to':
					params.dateTo = value;
					break;
				case 'format':
					params.format = value as ImageFormat;
					break;
				default:
					tokens.push(part);
			}
		} else {
			tokens.push(part);
		}
	}

	return { params, freeText: tokens.join(' ') };
}

function parseFilters(filters: string[] | undefined): SearchParams {
	const params: SearchParams = {};
	if (!filters) return params;

	for (const f of filters) {
		const [key, value] = f.split('=');
		if (!key || !value) continue;
		switch (key) {
			case 'min':
				params.minValue = parseFloat(value);
				break;
			case 'max':
				params.maxValue = parseFloat(value);
				break;
			case 'standard':
				params.standardName = value;
				break;
			case 'from':
				params.dateFrom = value;
				break;
			case 'to':
				params.dateTo = value;
				break;
			case 'format':
				params.format = value.includes(',') ? value.split(',').map((s) => s.trim() as ImageFormat) : (value as ImageFormat);
				break;
		}
	}

	return params;
}

export const searchCommand = new Command('search')
	.description('搜索历史估值记录')
	.argument('[query]', '搜索查询 (支持 min:100 max:500 standard:photo 等前缀，或自由文本)')
	.option(
		'--filter <key=value>',
		'结构化过滤 (可重复)',
		(val: string, prev: string[]) => [...prev, val],
		[] as string[],
	)
	.option('--limit <n>', '结果数量限制', '20')
	.option(FORMAT_FLAGS, FORMAT_DESCRIPTION, 'text')
	.action((query: string | undefined, opts: SearchOptions) => {
		try {
			const env = loadEnv();
			bootstrap(env.IMGDATA_DIR);

			const limit = Math.min(parseInt(opts.limit ?? '20', 10), 50);
			const { params: queryParams, freeText } = parseQuery(query ?? '');
			const filterParams = parseFilters(opts.filter);

			// Merge: CLI --filter overrides query prefixes
			const params: SearchParams = {
				...queryParams,
				...filterParams,
				limit,
			};

			// If there are structured params, use structured search
			const hasStructuredParams =
				params.minValue !== undefined ||
				params.maxValue !== undefined ||
				params.standardName !== undefined ||
				params.dateFrom !== undefined ||
				params.dateTo !== undefined ||
				params.format !== undefined;

			let records;
			if (hasStructuredParams) {
				records = search(params);
			} else if (freeText) {
				records = searchByText(freeText, limit);
			} else {
				// No query — return latest records
				records = search({ limit });
			}

			if (isJsonFormat(opts.format)) {
				console.log(renderRecordsJson(records));
			} else {
				console.log(renderSearchResults(records));
			}
		} catch (e) {
			if (e instanceof AppError) {
				console.error(e.message);
				process.exit(e.exitCode);
			}
			throw e;
		}
	});
