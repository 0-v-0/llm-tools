#!/usr/bin/env node
import { runCli } from './cli/index.js';

runCli(process.argv).catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
