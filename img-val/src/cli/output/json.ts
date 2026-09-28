import type { ValuationRecord } from '../../storage/types.ts';
import type { ValuationResult } from '../../valuation/engine.ts';

export function renderJson(result: ValuationResult): string {
	return JSON.stringify(result, null, 2);
}

export function renderJsonArray(results: ValuationResult[]): string {
	return JSON.stringify(results, null, 2);
}

export function renderRecordsJson(records: ValuationRecord[]): string {
	return JSON.stringify(records, null, 2);
}
