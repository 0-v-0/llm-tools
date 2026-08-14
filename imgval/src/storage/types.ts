import type { ImageFormat, Corruption } from '@llm-image/shared';
export type { ImageFormat, Corruption };
export type Confidence = 'low' | 'medium' | 'high';

export interface ValuationRecord {
	id: number;
	imageHash: string;
	url: string;
	imageFormat: ImageFormat;
	width: number;
	height: number;
	channels: number | null;
	sizeBytes: number;
	corruption: Corruption;
	minValue: number;
	maxValue: number;
	uncertainty: number;
	currency: string;
	standardName: string;
	standardVersion: string | null;
	llmProvider: string;
	llmModel: string;
	description: string;
	notes: string[];
	toolUsed: boolean;
	toolFallback: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	valuedAt: string;
}

export interface SearchParams {
	minValue?: number | undefined;
	maxValue?: number | undefined;
	standardName?: string | undefined;
	dateFrom?: string | undefined;
	dateTo?: string | undefined;
	format?: ImageFormat | undefined;
	limit?: number | undefined;
}

export interface ValuationInsert {
	imageHash: string;
	url: string;
	imageFormat: ImageFormat;
	width: number;
	height: number;
	channels: number | null;
	sizeBytes: number;
	corruption: Corruption;
	minValue: number;
	maxValue: number;
	uncertainty: number;
	currency: string;
	standardName: string;
	standardVersion: string | null;
	llmProvider: string;
	llmModel: string;
	description: string;
	notes: string[];
	toolUsed: boolean;
	toolFallback: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	rawLlmText: string | null;
}
