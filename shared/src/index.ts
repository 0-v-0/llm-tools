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
} from './llm/provider.ts';
export { OpenAIProvider } from './llm/openai.ts';
export { AnthropicProvider } from './llm/anthropic.ts';
export { createProvider, validateProviderConfig } from './llm/factory.ts';
export type { ProviderConfig } from './llm/factory.ts';
export { createLlmConfigSchema, resolveProviderConfig } from './llm/config.ts';
export type { LlmConfig, ProviderEnv } from './llm/config.ts';

// Image processing
export { processImage } from './image/processor.ts';
export type { ProcessedImage } from './image/processor.ts';
export { hashBuffer } from './image/hash.ts';
export type { ImageFormat } from './image/types.ts';

// SQLite storage
export { openSqlite } from './storage/sqlite.ts';
export type { DB } from './storage/sqlite.ts';

// Error hierarchy
export {
	AppError,
	ConfigError,
	StandardError,
	ImageError,
	LLMError,
	StorageError,
	ParseError,
} from './util/errors.ts';
export type { ExitCode } from './util/errors.ts';

// File system helpers
export { walk, extname } from './util/walk.ts';
export type { WalkOptions } from './util/walk.ts';
