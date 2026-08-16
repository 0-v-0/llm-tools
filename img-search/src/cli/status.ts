import { AppError } from '@llm-image/shared';
import { Command } from 'commander';
import { loadEnv } from '../config/env.js';
import { bootstrap } from '../config/paths.js';
import { countByStatus, countTotal } from '../storage/repository.image.js';

export const statusCommand = new Command('status')
	.description('显示图片库状态')
	.option('--json', '输出 JSON 格式')
	.action((opts: { json?: boolean }) => {
		try {
			const env = loadEnv();
			bootstrap(env.IMGDATA_DIR);

			const total = countTotal();
			const byStatus = countByStatus();

			if (opts.json) {
				console.log(JSON.stringify({ total, byStatus }, null, 2));
			} else {
				console.log(`图片库状态:`);
				console.log(`  总计: ${total}`);
				console.log(`  已索引: ${byStatus.indexed}`);
				console.log(`  待处理: ${byStatus.pending}`);
				console.log(`  处理中: ${byStatus.processing}`);
				console.log(`  已嵌入: ${byStatus.embedded}`);
				console.log(`  失败: ${byStatus.failed}`);
			}
		} catch (e) {
			if (e instanceof AppError) {
				console.error(e.message);
				process.exit(e.exitCode);
			}
			throw e;
		}
	});
