import { describe, it, expect } from 'vitest';
import { parseStandard } from '../../src/standards/parser.js';
import { StandardError } from '../../src/util/errors.js';

describe('standards-parser', () => {
	const validMarkdown = `---
name: test-standard
description: A test valuation standard
version: "1.0.0"
currency: CNY
image_formats: [jpeg, png, webp]
tags: [test]
---

# Test Standard

## 1. Scoring

Some rubric content here.
`;

	it('parses valid frontmatter and body', () => {
		const std = parseStandard(validMarkdown, 'filesystem', '/path/to/test.md');
		expect(std.frontmatter.name).toBe('test-standard');
		expect(std.frontmatter.description).toBe('A test valuation standard');
		expect(std.frontmatter.version).toBe('1.0.0');
		expect(std.frontmatter.currency).toBe('CNY');
		expect(std.frontmatter.image_formats).toEqual(['jpeg', 'png', 'webp']);
		expect(std.frontmatter.tags).toEqual(['test']);
		expect(std.body).toContain('# Test Standard');
		expect(std.body).toContain('## 1. Scoring');
		expect(std.source).toBe('filesystem');
		expect(std.filePath).toBe('/path/to/test.md');
	});

	it('applies defaults for optional fields', () => {
		const minimal = `---
name: minimal
description: Minimal standard
---
Body content`;
		const std = parseStandard(minimal, 'builtin');
		expect(std.frontmatter.name).toBe('minimal');
		expect(std.frontmatter.currency).toBe('CNY');
		expect(std.frontmatter.version).toBeUndefined();
	});

	it('throws on missing required name', () => {
		const missingName = `---
description: No name
---
Body`;
		expect(() => parseStandard(missingName, 'filesystem')).toThrow(StandardError);
	});

	it('throws on missing required description', () => {
		const missingDesc = `---
name: test
---
Body`;
		expect(() => parseStandard(missingDesc, 'filesystem')).toThrow(StandardError);
	});

	it('throws on malformed YAML', () => {
		const badYaml = `---
name: [invalid
description: test
---
Body`;
		expect(() => parseStandard(badYaml, 'filesystem')).toThrow();
	});
});
