export type ImportStatus = 'pending' | 'processing' | 'embedded' | 'indexed' | 'failed';

export interface ImageImportRecord {
	id: number;
	sourcePath: string;
	hash: string;
	status: ImportStatus;
	qdrantPointId: string | null;
	textDescription: string | null;
	descriptionModel: string | null;
	error: string | null;
	importedAt: string;
	processedAt: string | null;
}

export interface ImageImportInsert {
	sourcePath: string;
	hash: string;
	status: ImportStatus;
}
