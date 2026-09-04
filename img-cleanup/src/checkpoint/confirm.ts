import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

/** 交互确认的可注入依赖（单测用）。 */
export interface ConfirmPrompt {
	ask: (question: string) => Promise<string>;
	isTTY: boolean;
}

export function defaultPrompt(): ConfirmPrompt {
	return {
		isTTY: Boolean(input.isTTY),
		ask: async (question: string) => {
			const rl = createInterface({ input, output });
			try {
				return await rl.question(question);
			} finally {
				rl.close();
			}
		},
	};
}

/**
 * standard 变更时的警告 + 确认。
 *
 * 强制复用语义：按 URL 级匹配复用 verdicts；groupKey/bucketLabel 差异可忽略，
 * 因为 prompt 未透露任何估值信息，LLM 的视觉判断与标准无关。
 *
 * - `force` 为 true → 直接返回 true（跳过提问）。
 * - 非 TTY → 警告后返回 false（自动重跑）。
 * - TTY → 提问，`y/yes` 返回 true，否则 false。
 */
export async function confirmForcedReuse(
	oldStandard: string | null,
	newStandard: string | null,
	opts: { force?: boolean; prompt?: ConfirmPrompt } = {},
): Promise<boolean> {
	if (opts.force) return true;

	const prompt = opts.prompt ?? defaultPrompt();
	const oldLabel = oldStandard ?? '(全部)';
	const newLabel = newStandard ?? '(全部)';
	const warning =
		`[warn] standard 已变更: ${oldLabel} → ${newLabel}。\n` +
		`[warn] checkpoint 中的 LLM 视觉比较结果将按 URL 匹配强制复用；` +
		`分组/分桶可能与之前不同。是否继续？[y/N]`;

	if (!prompt.isTTY) {
		console.error(
			`${warning}\n[warn] 非交互终端，需 --force 才能强制复用；checkpoint 将重新开始。`,
		);
		return false;
	}

	console.error(warning);
	const answer = (await prompt.ask('确认强制复用？[y/N] ')).trim().toLowerCase();
	return answer === 'y' || answer === 'yes';
}
