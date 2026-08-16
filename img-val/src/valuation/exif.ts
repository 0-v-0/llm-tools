import exifr from 'exifr';

export interface ExifSummary {
	make?: string;
	model?: string;
	software?: string;
	lens?: string;
	aperture?: number;
	shutterSpeed?: number;
	iso?: number;
	focalLength?: number;
	exposureBias?: number;
	whiteBalance?: string;
	dateTaken?: string;
	orientation?: string;
	gps?: { latitude: number; longitude: number };
}

const KEY_MAP: Record<string, keyof ExifSummary> = {
	Make: 'make',
	Model: 'model',
	Software: 'software',
	LensModel: 'lens',
	FNumber: 'aperture',
	ExposureTime: 'shutterSpeed',
	ISO: 'iso',
	FocalLength: 'focalLength',
	ExposureCompensation: 'exposureBias',
	WhiteBalance: 'whiteBalance',
	DateTimeOriginal: 'dateTaken',
	Orientation: 'orientation',
};

/**
 * Extract a compact, LLM-friendly EXIF summary from an image file.
 * Returns an empty object when the file has no EXIF data or cannot be parsed.
 */
export async function extractExif(filePath: string): Promise<ExifSummary> {
	const out: Record<string, unknown> = {};

	try {
		const raw = (await exifr.parse(filePath)) as Record<string, unknown> | undefined;
		if (raw && typeof raw === 'object') {
			for (const [tag, key] of Object.entries(KEY_MAP)) {
				const value = raw[tag];
				if (value !== undefined) {
					out[key] = normalizeValue(value);
				}
			}
		}
	} catch {
		// unreadable or no EXIF — return what we have
	}

	try {
		const gps = await exifr.gps(filePath);
		if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
			out.gps = { latitude: gps.latitude, longitude: gps.longitude };
		}
	} catch {
		// no GPS — skip
	}

	return out as ExifSummary;
}

function normalizeValue(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	return value;
}
