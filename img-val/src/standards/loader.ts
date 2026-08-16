import { StandardError } from '@llm-image/shared';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, extname, isAbsolute } from 'node:path';
import { getStandardsDir, getBuiltinStandardsDir } from '../config/paths.js';
import { parseStandard, type Standard } from './parser.js';

function looksLikePath(ref: string): boolean {
	return isAbsolute(ref) || ref.includes('/') || ref.includes('\\') || extname(ref) === '.md';
}

function loadFromFile(filePath: string): Standard {
	if (!existsSync(filePath)) {
		throw new StandardError(`标准文件不存在: ${filePath}`);
	}
	const content = readFileSync(filePath, 'utf-8');
	return parseStandard(content, 'filesystem', filePath);
}

function findByName(name: string, standardsDir?: string): Standard | null {
	// 1. Try filesystem standards dir (user overrides)
	const fsDir = getStandardsDir(standardsDir);
	if (existsSync(fsDir)) {
		for (const file of readdirSync(fsDir)) {
			if (!file.endsWith('.md')) continue;
			const fullPath = join(fsDir, file);
			const content = readFileSync(fullPath, 'utf-8');
			try {
				const std = parseStandard(content, 'filesystem', fullPath);
				if (std.frontmatter.name === name) return std;
			} catch {
				// skip invalid files
			}
		}
	}

	// 2. Try builtin standards
	const builtinDir = getBuiltinStandardsDir();
	if (existsSync(builtinDir)) {
		for (const file of readdirSync(builtinDir)) {
			if (!file.endsWith('.md')) continue;
			const fullPath = join(builtinDir, file);
			const content = readFileSync(fullPath, 'utf-8');
			try {
				const std = parseStandard(content, 'builtin', fullPath);
				if (std.frontmatter.name === name) return std;
			} catch {
				// skip invalid files
			}
		}
	}

	return null;
}

export async function resolveStandard(ref?: string, standardsDir?: string): Promise<Standard> {
	if (!ref) {
		// default: look for 'default-photo'
		const found = findByName('default-photo', standardsDir);
		if (!found) {
			throw new StandardError('默认标准 default-photo 未找到');
		}
		return found;
	}

	if (looksLikePath(ref)) {
		return loadFromFile(ref);
	}

	const found = findByName(ref, standardsDir);
	if (!found) {
		throw new StandardError(`标准未找到: ${ref}`);
	}
	return found;
}

export function listStandards(standardsDir?: string): {
	name: string;
	description: string;
	source: string;
	filePath?: string;
}[] {
	const results: { name: string; description: string; source: string; filePath?: string }[] = [];
	const seen = new Set<string>();

	// Filesystem first
	const fsDir = getStandardsDir(standardsDir);
	if (existsSync(fsDir)) {
		for (const file of readdirSync(fsDir)) {
			if (!file.endsWith('.md')) continue;
			const fullPath = join(fsDir, file);
			const content = readFileSync(fullPath, 'utf-8');
			try {
				const std = parseStandard(content, 'filesystem', fullPath);
				if (!seen.has(std.frontmatter.name)) {
					results.push({
						name: std.frontmatter.name,
						description: std.frontmatter.description,
						source: 'filesystem',
						filePath: fullPath,
					});
					seen.add(std.frontmatter.name);
				}
			} catch {
				// skip
			}
		}
	}

	// Then builtin (skip if already overridden by filesystem)
	const builtinDir = getBuiltinStandardsDir();
	if (existsSync(builtinDir)) {
		for (const file of readdirSync(builtinDir)) {
			if (!file.endsWith('.md')) continue;
			const fullPath = join(builtinDir, file);
			const content = readFileSync(fullPath, 'utf-8');
			try {
				const std = parseStandard(content, 'builtin', fullPath);
				if (!seen.has(std.frontmatter.name)) {
					results.push({
						name: std.frontmatter.name,
						description: std.frontmatter.description,
						source: 'builtin',
						filePath: fullPath,
					});
					seen.add(std.frontmatter.name);
				}
			} catch {
				// skip
			}
		}
	}

	return results;
}
