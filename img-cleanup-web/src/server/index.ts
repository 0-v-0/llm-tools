import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createProvider, resolveProviderConfig, type LLMProvider } from '@llm-image/shared';
import {
	bootstrap,
	getCheckpointPath,
	loadConfig,
	loadEnv,
} from 'img-cleanup/api';
import { createApp } from './app.ts';
import { SessionManager } from './session.ts';

const PORT = Number(process.env.PORT ?? 5176);
const HOST = '127.0.0.1';

const env = loadEnv();
bootstrap(process.env.IMGDATA_DIR);
const config = loadConfig();
// LLM 密钥未配置时回退到手动模式启动：自动选择/建议/锦标赛不可用，
// 批次比较仍可逐批手动挑选（裁决照常写入 checkpoint 缓存）。
let provider: LLMProvider | null = null;
try {
	provider = createProvider(resolveProviderConfig(config.llm, env));
} catch (e) {
	console.warn(
		`[img-cleanup-web] LLM 不可用（${e instanceof Error ? e.message : String(e)}），以手动模式启动：自动选择与锦标赛淘汰将不可用`,
	);
}
const checkpointPath = getCheckpointPath(process.env.IMGDATA_DIR);

const manager = new SessionManager({
	config,
	provider,
	checkpointPath,
	checkpointEnabled: config.checkpointEnabled,
});

const app = createApp({
	manager,
	// 生产模式（vite build 产物存在）时托管前端
	...(existsSync('dist/client/index.html') ? { webDist: 'dist/client' } : {}),
});

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
	console.log(`img-cleanup-web 已启动: http://${HOST}:${PORT}`);
});
