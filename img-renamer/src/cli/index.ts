import { Command } from 'commander';
import { renameCommand } from './rename.js';
import { clusterCommand } from './cluster.js';

const program = new Command();

program
	.name('imgrenamer')
	.description('LLM 驱动的图片重命名与聚类工具')
	.version('0.1.0');

program.addCommand(renameCommand);
program.addCommand(clusterCommand);

export async function runCli(argv: string[]): Promise<void> {
	await program.parseAsync(argv);
}