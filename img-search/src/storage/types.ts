export type ImportStatus = 'pending' | 'processing' | 'embedded' | 'indexed' | 'failed';

export interface ImageImportRecord {
	id: number;
	/** 原始文件 BLAKE3 指纹，file-index 关联键（非 UNIQUE：仅 EXIF 不同的图片共用同一行） */
	blake3: string;
	/** 处理后图片 SHA-256（sharp 缩放 + JPEG 重编码、EXIF 剥离后），视觉内容去重键（UNIQUE） */
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
	blake3: string;
	hash: string;
	status: ImportStatus;
}
