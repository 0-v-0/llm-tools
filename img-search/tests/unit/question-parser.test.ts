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

describe('parseQuestionsResponse fallback branches', () => {
	it('falls back to text parsing when tool call arguments are invalid JSON', () => {
		const toolCalls = [
			{ name: 'submit_questions', arguments: '{not valid json' },
		];
		const text = JSON.stringify({
			questions: [
				{ question: 'From text', rationale: 'Text rationale' },
			],
		});
		const result = parseQuestionsResponse(text, toolCalls);
		expect(result).toHaveLength(1);
		expect(result[0]?.question).toBe('From text');
	});

	it('throws (does not fall back) when tool call arguments are valid JSON but structurally invalid', () => {
		// JSON.parse succeeds, so validateQuestions' Error is not a SyntaxError
		// and must be rethrown instead of silently falling back to the text.
		const toolCalls = [
			{
				name: 'submit_questions',
				arguments: JSON.stringify({
					questions: [{ question: '', rationale: 'Empty question' }],
				}),
			},
		];
		const text = JSON.stringify({
			questions: [{ question: 'From text', rationale: 'Text rationale' }],
		});
		expect(() => parseQuestionsResponse(text, toolCalls)).toThrow(
			'question[0].question must be a non-empty string',
		);
	});

	it('accepts a bare top-level JSON array of question objects', () => {
		const text = JSON.stringify([
			{ question: 'Is it a cat?', rationale: 'Separates cats from dogs' },
			{ question: 'Is it night?', rationale: 'Splits day/night scenes' },
		]);
		const result = parseQuestionsResponse(text);
		expect(result).toHaveLength(2);
		expect(result[0]?.question).toBe('Is it a cat?');
		expect(result[1]?.rationale).toBe('Splits day/night scenes');
	});

	it('falls through to regex when JSON is valid but has no questions key', () => {
		// JSON.parse succeeds, parsed.questions is undefined -> no return,
		// no code fence, regex finds nothing -> parse failure
		const text = JSON.stringify({ note: 'no questions here' });
		expect(() => parseQuestionsResponse(text)).toThrow('Failed to parse questions');
	});

	it('falls back to regex when the code fence contains invalid JSON', () => {
		const text = [
			'Here you go:',
			'```json',
			'{ this is not json',
			'```',
			'"question": "Is it red?",',
			'"rationale": "Separates red from blue"',
		].join('\n');
		const result = parseQuestionsResponse(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.question).toBe('Is it red?');
		expect(result[0]?.rationale).toBe('Separates red from blue');
	});

	it('pairs each regex-matched question only with its immediately following rationale', () => {
		// The second rationale must not be stolen by the first question
		const text = [
			'"question": "Is it a cat?",',
			'"rationale": "Separates cats from dogs",',
			'"question": "Is it indoors?",',
			'"rationale": "Separates indoor from outdoor"',
		].join('\n');
		const result = parseQuestionsResponse(text);
		expect(result).toHaveLength(2);
		expect(result[0]?.question).toBe('Is it a cat?');
		expect(result[0]?.rationale).toBe('Separates cats from dogs');
		expect(result[1]?.question).toBe('Is it indoors?');
		expect(result[1]?.rationale).toBe('Separates indoor from outdoor');
	});

	it('truncates questions containing apostrophes in the regex fallback', () => {
		// The regex value pattern is [^"']+, so an apostrophe inside a
		// double-quoted value terminates the capture early. Documented
		// current behavior: "Is it John's photo?" is captured as "Is it John".
		const text = [
			'"question": "Is it John\'s photo?",',
			'"rationale": "Distinguishes people from animals"',
		].join('\n');
		const result = parseQuestionsResponse(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.question).toBe('Is it John');
		expect(result[0]?.rationale).toBe('Distinguishes people from animals');
	});

	it('trims whitespace around question and rationale', () => {
		const text = JSON.stringify({
			questions: [
				{
					question: '  Is it outdoors?  ',
					rationale: '\n\tSeparates outdoor from indoor scenes\n',
				},
			],
		});
		const result = parseQuestionsResponse(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.question).toBe('Is it outdoors?');
		expect(result[0]?.rationale).toBe('Separates outdoor from indoor scenes');
	});
});
