import type { ImageFormat } from '@llm-image/shared';
export type { ImageFormat };

/**
 * A distinct file in the valuation database, with its highest recorded
 * max_value and the associated technical metadata. Used as the unit of
 * grouping, batching, and LLM comparison throughout img-cleanup.
 */
export interface ImageEntry {
	/** The file URL (canonical decoded form, same as img-val stores). */
	url: string;
	/** BLAKE3 hash of the processed image (from img-val). */
	imageHash: string;
	/** Highest recorded max_value for this URL across all valuations. */
	maxValue: number;
	/** Lowest recorded min_value for this URL. */
	minValue: number;
	/** Standard name from the valuation with the highest max_value. */
	standardName: string;
	/** Image format (jpeg, png, webp). */
	imageFormat: ImageFormat;
	/** Image width in pixels. */
	width: number;
	/** Image height in pixels. */
	height: number;
	/** Number of channels (may be null). */
	channels: number | null;
	/** File size in bytes. */
	sizeBytes: number;
	/** Undecodable pixels (damage indicator). */
	undecodablePixels: number;
}
