import { Command } from 'commander';
import { importCommand } from './import.js';
import { searchCommand } from './search.js';
import { statusCommand } from './status.js';

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
