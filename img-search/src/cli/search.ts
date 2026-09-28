import { AppError, createProvider, resolveProviderConfig } from '@llm-image/shared';
import { Command } from 'commander';
import { stdin, stdout, stderr } from 'node:process';
import { createInterface } from 'readline/promises';
import { loadConfig, type AppConfig } from '../config/config.ts';
import { loadEnv } from '../config/env.ts';
import { bootstrap } from '../config/paths.ts';
import { createEmbeddingProvider } from '../embedding/factory.ts';
import type { SearchOptions } from '../search/algorithm.ts';
import { SearchAlgorithm } from '../search/algorithm.ts';
import type { ParsedQuestion } from '../search/question-parser.ts';
import type { SessionConfig, SearchResult } from '../search/session.ts';
import { closeDb, getDb } from '../storage/db.ts';
import { QdrantStore } from '../storage/qdrant.ts';
import { sanitizeForTerminal } from '../util/sanitize.ts';

interface ParsedAnswer {
	value: number | 'unknown';
	/** 输入无法解析为 0-1 的数值或 unknown 时为 true。 */
	invalid: boolean;
}

/** 将用户输入解析为 0-1 的数值或 unknown；无法解析时标记 invalid。 */
function parseAnswer(raw: string): ParsedAnswer {
	const answer = raw.trim().toLowerCase();
	if (answer === 'unknown' || answer === '?') {
		return { value: 'unknown', invalid: false };
	}
	const num = /^\d*\.?\d+$/.test(answer) ? parseFloat(answer) : Number.NaN;
	if (Number.isNaN(num) || num < 0 || num > 1) {
		return { value: 'unknown', invalid: true };
	}
	return { value: num, invalid: false };
}

/** 从应用配置构造搜索会话参数。 */
function buildSessionConfig(config: AppConfig): SessionConfig {
	return {
		beamSize: config.beamSize,
		topKQuestions: config.topKQuestions,
		maxRounds: config.maxRounds,
		minRounds: config.minRounds,
		igThreshold: config.igThreshold,
		alpha: config.alpha,
		lambda: config.lambda,
		candidateQuestions: config.candidateQuestions,
	};
}

export const searchCommand = new Command('search')
	.description('Interactive image search via Bayesian questioning')
	.option('-h, --hint <text>', 'Initial text hint to bootstrap candidates')
	.option('--json', 'Output results as JSON')
	.action(async (opts: { hint?: string; json?: boolean }) => {
		try {
			const env = loadEnv();
			const config = loadConfig();
			bootstrap(env.IMGDATA_DIR);
			getDb();

			const llm = createProvider(resolveProviderConfig(config.llm, env));
			const embedding = createEmbeddingProvider(env, config);
			const qdrant = new QdrantStore(
				env.QDRANT_URL,
				env.QDRANT_COLLECTION,
				embedding.dimensions,
				env.QDRANT_API_KEY,
			);

			const algorithm = new SearchAlgorithm({ llm, embedding, qdrant });

			const searchOptions: SearchOptions = opts.hint !== undefined ? { hint: opts.hint } : {};
			await algorithm.initialize(buildSessionConfig(config), searchOptions);

			const rl = createInterface({ input: stdin, output: stdout });

			const onQuestion = (question: ParsedQuestion, candidates: SearchResult[]) => {
				stdout.write(`\n[Round ${algorithm.getRound()}] Top candidates:\n`);
				for (const [i, c] of candidates.entries()) {
					stdout.write(
						`  ${i + 1}. ${sanitizeForTerminal(c.description)} (${(c.probability * 100).toFixed(1)}%)\n`,
					);
				}
			};

			try {
				while (!algorithm.isTerminated()) {
					const question = await algorithm.nextQuestion({ onQuestion });
					if (!question) {
						break;
					}

					stdout.write(`\nQuestion: ${sanitizeForTerminal(question.question)}\n`);
					stdout.write(`Rationale: ${sanitizeForTerminal(question.rationale)}\n`);
					let answerStr: string;
					try {
						answerStr = await rl.question('Your answer (0-1 or "unknown"): ');
					} catch {
						// stdin EOF/中断（如 Ctrl+D）：视为结束搜索，仍输出当前结果
						break;
					}

					const { value: parsedAnswer, invalid } = parseAnswer(answerStr);
					if (invalid) {
						stdout.write('Invalid answer, treating as unknown\n');
					}
					await algorithm.processAnswer(question, parsedAnswer);
				}
			} finally {
				rl.close();
				closeDb();
			}

			const results = algorithm.getResults(5);
			const reason = algorithm.getTerminationReason();

			if (opts.json) {
				stdout.write(JSON.stringify({ results, reason }, null, 2) + '\n');
			} else {
				stdout.write(`\n=== Search Complete ===\n`);
				stdout.write(`Termination reason: ${reason ?? 'unknown'}\n\n`);
				stdout.write(`Top ${results.length} results:\n`);
				for (const [i, r] of results.entries()) {
					stdout.write(`  ${i + 1}. ${sanitizeForTerminal(r.description)}\n`);
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
