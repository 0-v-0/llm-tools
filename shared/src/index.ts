// LLM provider abstraction
export type {
	StopReason,
	TextBlock,
	ImageUrlBlock,
	ToolCallBlock,
	ToolResultBlock,
	ContentBlock,
	LLMMessage,
	ToolFunctionDef,
	ToolDef,
	ResponseSchema,
	CompleteRequest,
	ToolCall,
	UsageInfo,
	CompleteResponse,
	LLMProvider,
	TopLogprob,
	LogprobToken,
	LogprobInfo,
} from './llm/provider.js';
export { OpenAIProvider } from './llm/openai.js';
export { AnthropicProvider } from './llm/anthropic.js';
export { createProvider, validateProviderConfig } from './llm/factory.js';
export type { ProviderConfig } from './llm/factory.js';

// Image processing
export { processImage } from './image/processor.js';
export type { ProcessedImage } from './image/processor.js';
export { hashBuffer } from './image/hash.js';
export type { ImageFormat } from './image/types.js';

// SQLite storage
export { openSqlite } from './storage/sqlite.js';
export type { DB } from './storage/sqlite.js';

// Error hierarchy
export {
	AppError,
	ConfigError,
	StandardError,
	ImageError,
	LLMError,
	StorageError,
	ParseError,
} from './util/errors.js';
export type { ExitCode } from './util/errors.js';
