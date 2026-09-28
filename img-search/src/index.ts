#!/usr/bin/env node
import { createProgram } from './cli/index.ts';

const program = createProgram();
program.parse();
