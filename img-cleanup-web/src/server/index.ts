import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createProvider, resolveProviderConfig } from '@llm-image/shared';
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
const provider = createProvider(resolveProviderConfig(config.llm, env));
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
