export type ExitCode =
	| 0 // success
	| 1 // generic / LLM error
	| 2 // config error
	| 3 // standard error
	| 4 // image error
	| 5; // storage error

export class AppError extends Error {
	readonly code: string;
	readonly exitCode: ExitCode;

	constructor(
		code: string,
		message: string,
		exitCode: ExitCode = 1,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = this.constructor.name;
		this.code = code;
		this.exitCode = exitCode;
	}
}

export class ConfigError extends AppError {
	constructor(message: string, cause?: unknown) {
		super('CONFIG', message, 2, cause);
	}
}

export class StandardError extends AppError {
	constructor(message: string, cause?: unknown) {
		super('STANDARD', message, 3, cause);
	}
}

export class ImageError extends AppError {
	constructor(message: string, cause?: unknown) {
		super('IMAGE', message, 4, cause);
	}
}

export class LLMError extends AppError {
	constructor(message: string, cause?: unknown) {
		super('LLM', message, 1, cause);
	}
}

export class StorageError extends AppError {
	constructor(message: string, cause?: unknown) {
		super('STORAGE', message, 5, cause);
	}
}

export class ParseError extends AppError {
	constructor(message: string, cause?: unknown) {
		super('PARSE', message, 1, cause);
	}
}
