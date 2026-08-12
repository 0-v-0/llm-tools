import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../config/env.js';
import { bootstrap } from '../config/paths.js';
import { processImage } from '../image/processor.js';
import { createProvider } from '../llm/factory.js';
import { resolveStandard } from '../standards/loader.js';
import { AppError, ImageError } from '../util/errors.js';
import { valuate } from '../valuation/engine.js';
import { renderJson } from './output/json.js';
import { renderValuationCard } from './output/table.js';

export const valueCommand = new Command('value')
	.description('对单张图片进行估值')
	.argument('<image-path>', '图片文件路径')
	.option('--standard <name|path>', '估值标准名称或文件路径', 'default-photo')
	.option('--json', '输出 JSON 格式')
	.option('--no-tools', '禁用工具调用')
	.option('--verbose', '输出调试信息')
	.action(
		async (
			imagePath: string,
			opts: {
				standard?: string;
				json?: boolean;
				tools?: boolean;
				verbose?: boolean;
			},
		) => {
			try {
				const env = loadEnv();
				bootstrap(env.IMGVAL_DB_DIR, env.IMGVAL_STANDARDS_DIR);

				const enableTools = opts.tools !== false && env.LLM_ENABLE_TOOLS;

				if (opts.verbose) {
					console.error(
						`[debug] provider=${env.LLM_PROVIDER} model=${env.OPENAI_MODEL} tools=${enableTools}`,
					);
				}

				const url = pathToFileURL(imagePath).href;
				const image = await processImage(url, env.IMGVAL_MAX_IMAGE_DIMENSION);
				const standard = await resolveStandard(opts.standard);
				const provider = createProvider(env);

				const result = await valuate({
					url,
					image,
					standard,
					provider,
					env,
					enableTools,
				});

				if (opts.json) {
					console.log(renderJson(result));
				} else {
					console.log(renderValuationCard(result));
				}
			} catch (e) {
				if (e instanceof AppError) {
					console.error(e.message);
					process.exit(e.exitCode);
				}
				throw e;
			}
		},
	);
