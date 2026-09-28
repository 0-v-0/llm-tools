import { Command } from 'commander';
import { importCommand } from './import.ts';
import { searchCommand } from './search.ts';
import { statusCommand } from './status.ts';

export function createProgram(): Command {
	const program = new Command();

	program
		.name('imgsearch')
		.description('智能图片搜索 — 通过 LLM 提问从图片库中定位目标图片')
		.version('0.1.0');

	program.addCommand(statusCommand);
	program.addCommand(importCommand);
	program.addCommand(searchCommand);

	return program;
}
