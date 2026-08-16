import { AppError, createProvider } from '@llm-image/shared';
import { Command } from 'commander';
import { stdin, stdout, stderr } from 'node:process';
import { createInterface } from 'readline/promises';
import type { ParsedQuestion } from '../search/question-parser.js';
import type { SessionConfig } from '../search/session.js';
import type { SearchResult } from '../search/session.js';
import { loadConfig } from '../config/config.js';
import { loadEnv } from '../config/env.js';
import { bootstrap } from '../config/paths.js';
import { createEmbeddingProvider } from '../embedding/factory.js';
import { SearchAlgorithm } from '../search/algorithm.js';
import { getDb } from '../storage/db.js';
import { QdrantStore } from '../storage/qdrant.js';

export const searchCommand = new Command('search')
	.description('Interactive image search via Bayesian questioning')
	.option('-h, --hint <text>', 'Initial text hint to bootstrap candidates')
	.option('--json', 'Output results as JSON')
	.action(async (opts: { hint?: string; json?: boolean }) => {
		try {
			const env = loadEnv();
			const config = loadConfig();
			bootstrap();
			getDb();

			const llm = createProvider(env);
			const embedding = createEmbeddingProvider(env, config);
			const qdrant = new QdrantStore(
				env.QDRANT_URL,
				env.QDRANT_COLLECTION,
				embedding.dimensions,
				env.QDRANT_API_KEY,
			);

			const algorithm = new SearchAlgorithm({ llm, embedding, qdrant });

			const sessionConfig: SessionConfig = {
				beamSize: config.beamSize,
				maxRounds: config.maxRounds,
				minRounds: config.minRounds,
				igThreshold: config.igThreshold,
				alpha: config.alpha,
				lambda: config.lambda,
				candidateQuestions: config.candidateQuestions,
			};

			const searchOptions: Parameters<typeof algorithm.initialize>[1] = {};
			if (opts.hint !== undefined) {
				searchOptions.hint = opts.hint;
			}
			await algorithm.initialize(sessionConfig, searchOptions);

			const rl = createInterface({ input: stdin, output: stdout });

			const onQuestion = (question: ParsedQuestion, candidates: SearchResult[]) => {
				stdout.write(`\n[Round ${algorithm.getRound()}] Top candidates:\n`);
				for (const [i, c] of candidates.entries()) {
					stdout.write(`  ${i + 1}. ${c.description} (${(c.probability * 100).toFixed(1)}%)\n`);
				}
			};

			while (!algorithm.isTerminated()) {
				const question = await algorithm.nextQuestion({ onQuestion });
				if (!question) {
					break;
				}

				stdout.write(`\nQuestion: ${question.question}\n`);
				stdout.write(`Rationale: ${question.rationale}\n`);
				const answerStr = await rl.question('Your answer (0-1 or "unknown"): ');
				const answer = answerStr.trim().toLowerCase();

				let parsedAnswer: number | 'unknown';
				if (answer === 'unknown' || answer === '?') {
					parsedAnswer = 'unknown';
				} else {
					const num = parseFloat(answer);
					if (Number.isNaN(num) || num < 0 || num > 1) {
						stdout.write('Invalid answer, treating as unknown\n');
						parsedAnswer = 'unknown';
					} else {
						parsedAnswer = num;
					}
				}

				await algorithm.processAnswer(question, parsedAnswer);
			}

			rl.close();

			const results = algorithm.getResults(5);
			const reason = algorithm.getTerminationReason();

			if (opts.json) {
				stdout.write(JSON.stringify({ results, reason }, null, 2) + '\n');
			} else {
				stdout.write(`\n=== Search Complete ===\n`);
				stdout.write(`Termination reason: ${reason ?? 'unknown'}\n\n`);
				stdout.write(`Top ${results.length} results:\n`);
				for (const [i, r] of results.entries()) {
					stdout.write(`  ${i + 1}. ${r.description}\n`);
					stdout.write(`     Probability: ${(r.probability * 100).toFixed(1)}%\n`);
					if (r.sourcePath) {
						stdout.write(`     Path: ${r.sourcePath}\n`);
					}
				}
			}
		} catch (e) {
			if (e instanceof AppError) {
				stderr.write(`${e.message}\n`);
				process.exit(e.exitCode);
			}
			throw e;
		}
	});
