import { Command } from 'commander';
import { moveLowCommand } from './move-low.ts';
import { searchCommand } from './search.ts';
import { standardsCommand } from './standards.ts';
import { valueCommand } from './value.ts';

const program = new Command();

program
	.name('imgval')
	.description('图片估值系统 — TypeScript CLI for LLM-based image valuation')
	.version('0.1.0');

// Default command: imgval <path> (value or batch if directory)
program.addCommand(valueCommand, { isDefault: true });
program.addCommand(moveLowCommand);
program.addCommand(searchCommand);
program.addCommand(standardsCommand);

export async function runCli(argv: string[]): Promise<void> {
	await program.parseAsync(argv);
}
