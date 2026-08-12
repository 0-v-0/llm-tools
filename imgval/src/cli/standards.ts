import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { loadEnv } from '../config/env.js';
import { bootstrap } from '../config/paths.js';
import { listStandards, resolveStandard } from '../standards/loader.js';
import { AppError } from '../util/errors.js';

export const standardsCommand = new Command('standards').description('管理估值标准');

standardsCommand
	.command('list')
	.description('列出所有可用标准')
	.action(() => {
		try {
			const env = loadEnv();
			bootstrap(env.IMGVAL_DB_DIR, env.IMGVAL_STANDARDS_DIR);

			const standards = listStandards();
			if (standards.length === 0) {
				console.log('未找到任何估值标准');
				return;
			}

			console.log('\n可用估值标准:\n');
			for (const s of standards) {
				const sourceTag = s.source === 'builtin' ? '[builtin]' : '[user]';
				console.log(`  ${sourceTag} ${s.name}`);
				console.log(`    ${s.description}`);
				if (s.filePath) {
					console.log(`    路径: ${s.filePath}`);
				}
				console.log('');
			}
		} catch (e) {
			if (e instanceof AppError) {
				console.error(e.message);
				process.exit(e.exitCode);
			}
			throw e;
		}
	});

standardsCommand
	.command('show <name>')
	.description('显示标准完整内容')
	.action(async (name: string) => {
		try {
			const env = loadEnv();
			bootstrap(env.IMGVAL_DB_DIR, env.IMGVAL_STANDARDS_DIR);

			const standard = await resolveStandard(name);
			if (standard.filePath) {
				console.log(readFileSync(standard.filePath, 'utf-8'));
			} else {
				console.log(`名称: ${standard.frontmatter.name}`);
				console.log(`描述: ${standard.frontmatter.description}`);
				console.log(`\n${standard.body}`);
			}
		} catch (e) {
			if (e instanceof AppError) {
				console.error(e.message);
				process.exit(e.exitCode);
			}
			throw e;
		}
	});
