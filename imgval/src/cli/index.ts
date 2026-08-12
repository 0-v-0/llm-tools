import { Command } from 'commander';
import { batchCommand } from './batch.js';
import { searchCommand } from './search.js';
import { standardsCommand } from './standards.js';
import { valueCommand } from './value.js';

const program = new Command();

program
	.name('imgval')
	.description('图片估值系统 — TypeScript CLI for LLM-based image valuation')
	.version('0.1.0');

// Default command: imgval <image-path> (value)
program.addCommand(valueCommand, { isDefault: true });
program.addCommand(batchCommand);
program.addCommand(searchCommand);
program.addCommand(standardsCommand);

export async function runCli(argv: string[]): Promise<void> {
	await program.parseAsync(argv);
}
