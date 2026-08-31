import type { ImageFormat } from '@llm-image/shared';
export type { ImageFormat };
/** 连续置信度浮点数，由聚合 logprob 经 exp 派生（值域 (0,1]，越大越自信）；缺失为 null。 */
export type Confidence = number;

export interface ValuationRecord {
	id: number;
	imageHash: string;
	url: string;
	imageFormat: ImageFormat;
	width: number;
	height: number;
	channels: number | null;
	sizeBytes: number;
	undecodablePixels: number;
	minValue: number;
	maxValue: number;
	currency: string;
	standardName: string;
	standardVersion: string | null;
	llmModel: string;
	description: string;
	notes: string[];
	toolUsed: boolean;
	toolFallback: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	minLogprob: number | null;
	maxLogprob: number | null;
	confidence: number | null;
	samplesMin: number;
	samplesMax: number;
	valuedAt: string;
}

export interface SearchParams {
	minValue?: number | undefined;
	maxValue?: number | undefined;
	standardName?: string | undefined;
	dateFrom?: string | undefined;
	dateTo?: string | undefined;
	format?: ImageFormat | ImageFormat[] | undefined;
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
	undecodablePixels: number;
	minValue: number;
	maxValue: number;
	currency: string;
	standardName: string;
	standardVersion: string | null;
	llmModel: string;
	description: string;
	notes: string[];
	toolUsed: boolean;
	toolFallback: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	minLogprob: number | null;
	maxLogprob: number | null;
	confidence: number | null;
	samplesMin: number;
	samplesMax: number;
	rawLlmText: string | null;
}
