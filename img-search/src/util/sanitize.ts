/**
 * 终端输出清理：LLM 生成的文本（图片描述、问题、理由）和错误信息（可能内嵌
 * 远端 API 的响应体）属于不可信输入，直接写入终端时，其中的 ANSI 转义序列
 * 或控制字符可能被用于操纵终端（清屏、覆盖输出、注入键盘序列等）。
 */

// CSI 序列：ESC [ 参数字节(0x30–0x3F) 中间字节(0x20–0x2F) 最终字节(0x40–0x7E)
// 例如 ESC[2J（清屏）、ESC[1;31m（设置颜色）、ESC]0;...（OSC 标题见下）
const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;

// OSC 序列：ESC ] ... 以 BEL(0x07) 或 ST(ESC \) 结束
// 只匹配已正确闭合的序列；未闭合的由下面的裸 ESC 清理兜底
const ANSI_OSC = /\x1B\][^\x00-\x1F\x7F]*(?:\x07|\x1B\\)/g;

// 其余 C0 控制字符 + 裸 ESC + DEL（保留 \n 与 \t 用于正常换行/缩进）
const OTHER_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** 移除字符串中的 ANSI 转义序列与控制字符（保留换行和制表符），使其可安全写入终端。 */
export function sanitizeForTerminal(s: string): string {
	return s
		.replace(ANSI_CSI, '')
		.replace(ANSI_OSC, '')
		.replace(OTHER_CONTROL, '');
}
