import { Command } from 'commander';
import { cleanupCommand } from './cleanup.js';

const program = new Command();

program
	.name('imgcleanup')
	.description('图片清理助手 — 按数据库估值分组，LLM 批次比较后移走最不值得保留的图片')
	.version('0.1.0');

program.addCommand(cleanupCommand, { isDefault: true });

export async function runCli(argv: string[]): Promise<void> {
	await program.parseAsync(argv);
}
