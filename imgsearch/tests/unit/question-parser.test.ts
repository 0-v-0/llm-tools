import { describe, it, expect } from 'vitest';
import { parseQuestionsResponse } from '../../src/search/question-parser.js';

describe('parseQuestionsResponse', () => {
	it('parses tool call arguments', () => {
		const toolCalls = [
			{
				name: 'submit_questions',
				arguments: JSON.stringify({
					questions: [
						{ question: 'Is this a photo?', rationale: 'Distinguishes photos from illustrations' },
					],
				}),
			},
		];
		const result = parseQuestionsResponse('', toolCalls);
		expect(result).toHaveLength(1);
		expect(result[0]?.question).toBe('Is this a photo?');
		expect(result[0]?.rationale).toBe('Distinguishes photos from illustrations');
	});

	it('parses direct JSON', () => {
		const text = JSON.stringify({
			questions: [
				{ question: 'Is it outdoors?', rationale: 'Separates outdoor from indoor scenes' },
				{ question: 'Are there people?', rationale: 'Distinguishes portraits from landscapes' },
			],
		});
		const result = parseQuestionsResponse(text);
		expect(result).toHaveLength(2);
		expect(result[0]?.question).toBe('Is it outdoors?');
		expect(result[1]?.question).toBe('Are there people?');
	});

	it('parses JSON in code fence', () => {
		const text = `Here are the questions:
\`\`\`json
{
  "questions": [
    { "question": "Is it daytime?", "rationale": "Splits day/night scenes" }
  ]
}
\`\`\``;
		const result = parseQuestionsResponse(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.question).toBe('Is it daytime?');
	});

	it('falls back to regex extraction', () => {
		const text = `
"question": "Is this a landscape?",
"rationale": "Separates landscapes from portraits"
`;
		const result = parseQuestionsResponse(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.question).toBe('Is this a landscape?');
	});

	it('throws on empty response', () => {
		expect(() => parseQuestionsResponse('no questions here')).toThrow('Failed to parse questions');
	});

	it('throws on invalid question structure', () => {
		const text = JSON.stringify({ questions: [{ question: '', rationale: 'test' }] });
		expect(() => parseQuestionsResponse(text)).toThrow(
			'question[0].question must be a non-empty string',
		);
	});

	it('prefers tool call over text', () => {
		const toolCalls = [
			{
				name: 'submit_questions',
				arguments: JSON.stringify({
					questions: [{ question: 'From tool', rationale: 'Tool rationale' }],
				}),
			},
		];
		const text = JSON.stringify({
			questions: [{ question: 'From text', rationale: 'Text rationale' }],
		});
		const result = parseQuestionsResponse(text, toolCalls);
		expect(result[0]?.question).toBe('From tool');
	});

	it('falls back to text when tool call is not submit_questions', () => {
		const toolCalls = [{ name: 'other_tool', arguments: '{}' }];
		const text = JSON.stringify({
			questions: [{ question: 'From text', rationale: 'Text rationale' }],
		});
		const result = parseQuestionsResponse(text, toolCalls);
		expect(result[0]?.question).toBe('From text');
	});
});
